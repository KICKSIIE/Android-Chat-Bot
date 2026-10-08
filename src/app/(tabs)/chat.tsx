import { SaveFormat, manipulateAsync } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  useColorScheme,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, MaxContentWidth, Spacing } from '@/constants/theme';
import { BACKEND_URL, apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import * as Speech from 'expo-speech';

// Turns a chat reply into text that sounds natural when read aloud:
// drops the "Sources:" footer, replaces code blocks, keeps link text only, strips markdown symbols.
const cleanForSpeech = (s: string) =>
  s
    .split(/\n\s*Sources:\n/)[0]
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_#`>]/g, '')
    .trim();

const STREAM_TIMEOUT_MS = 5 * 60 * 1000; // give up on a reply after 5 minutes
const FLUSH_INTERVAL_MS = 50; // how often streamed text is pushed into React state
// Longest side of a photo after downsizing. Bigger photos cost far more GPU memory and context.
const MAX_IMAGE_SIDE = 896;
// Extra space for the iOS header when the keyboard is open. Adjust if your header height changes.
// Android relies on the system's own "resize" behavior, so it gets no offset (test with the keyboard open).
const KEYBOARD_OFFSET_IOS = 80;
// Within this many pixels of the bottom counts as "at the bottom" for auto-scroll.
const AT_BOTTOM_THRESHOLD = 80;

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  imageUri?: string; // local preview, only for photos sent in this session
  hasImage?: boolean; // photo sent earlier (loaded from the server)
};

type PendingImage = { uri: string; base64: string };

type Conversation = {
  id: number;
  title: string;
  updated_at: string;
};

// Converts a message row from the server into the shape the UI uses.
const toMessage = (m: any): Message => ({
  id: String(m.id),
  role: m.role,
  content: m.content,
  hasImage: !!m.has_image,
});

// Loads a stored photo from the server. The Image component sends the auth header itself,
// so the native layer handles downloading, decoding and caching (no manual base64 needed).
// Defined before MessageBubble, and outside it, so it isn't re-created on every render.
const RemoteImage = memo(function RemoteImage({ uri, token }: { uri: string; token: string }) {
  const [failed, setFailed] = useState(false);
  const source = useMemo(
    () => ({
      uri,
      headers: { Authorization: `Bearer ${token}`, 'ngrok-skip-browser-warning': 'true' },
    }),
    [uri, token],
  );

  if (failed) return <ThemedText type="small">📷 Photo</ThemedText>;
  return <Image source={source} style={styles.bubbleImage} onError={() => setFailed(true)} />;
});

// Memoized so that while a reply streams, only the bubble being updated re-renders.
const MessageBubble = memo(
  function MessageBubble({
    id, role, content, imageUri, hasImage, token, canSpeak, speaking, onSpeak,
  }: {
    id: string;
    role: Message['role'];
    content: string;
    imageUri?: string;
    hasImage?: boolean;
    token?: string | null;
    canSpeak?: boolean;
    speaking?: boolean;
    onSpeak?: (id: string, text: string) => void;
  }) {
    // Only saved messages have numeric ids; temporary local ids (like "123-u") have no server image yet.
    const remoteUri = hasImage && /^\d+$/.test(id) ? `${BACKEND_URL}/api/messages/${id}/image` : null;
    return (
      <ThemedView
        type="backgroundElement"
        style={[styles.bubble, role === 'user' ? styles.userBubble : styles.assistantBubble]}>
        {imageUri ? (
          <Image source={{ uri: imageUri }} style={styles.bubbleImage} />
        ) : remoteUri && token ? (
          <RemoteImage uri={remoteUri} token={token} />
        ) : hasImage ? (
          <ThemedText type="small">📷 Photo</ThemedText>
        ) : null}
        {content ? <ThemedText type="small">{content}</ThemedText> : null}
        {role === 'assistant' && canSpeak && content && onSpeak ? (
          <Pressable onPress={() => onSpeak(id, content)} hitSlop={8} style={styles.speakButton}>
            <ThemedText type="small">{speaking ? '⏹ Stop' : '🔊 Read aloud'}</ThemedText>
          </Pressable>
        ) : null}
      </ThemedView>
    );
  },
  // Custom comparison: re-render only when something the bubble actually shows has changed.
  (prev, next) =>
    prev.id === next.id &&
    prev.role === next.role &&
    prev.content === next.content &&
    prev.imageUri === next.imageUri &&
    prev.hasImage === next.hasImage &&
    prev.speaking === next.speaking &&
    prev.token === next.token &&
    prev.canSpeak === next.canSpeak &&
    prev.onSpeak === next.onSpeak,
);

export default function ChatScreen() {
  const { token, signOut } = useAuth();
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];

  // ---- Conversation + message state ----
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);

  const [webSearch, setWebSearch] = useState(false);
  const listRef = useRef<FlatList<Message>>(null);

  // Hooks must live inside the component. Tracks whether the user is near the bottom,
  // so streamed text only auto-scrolls when they haven't scrolled up to read.
  const atBottomRef = useRef(true);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    atBottomRef.current = distanceFromBottom < AT_BOTTOM_THRESHOLD;
  }, []);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const conversationsRef = useRef<Conversation[]>([]);
  conversationsRef.current = conversations;
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Shared modal for "new chat" and "rename" (nameTargetId === null means creating)
  const [nameModalVisible, setNameModalVisible] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [nameTargetId, setNameTargetId] = useState<number | null>(null);

  // ---- Streaming bookkeeping ----
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const streamIdRef = useRef(0); // bumped to invalidate an in-flight stream
  const loadSeqRef = useRef(0); // guards against out-of-order message loads

  // Async callbacks (like voice input) run long after the render that created them.
  // These refs always hold the LATEST values so those callbacks never use stale ones.
  const inputRef = useRef('');
  inputRef.current = input;
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;

  // ---- Read aloud ----
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  // Mirror of speakingId so toggleSpeak can read it without depending on it. That keeps
  // toggleSpeak's identity stable, so memoized bubbles don't hold an outdated callback.
  const speakingIdRef = useRef<string | null>(null);

  const setSpeaking = useCallback((id: string | null) => {
    speakingIdRef.current = id;
    setSpeakingId(id);
  }, []);

  const stopSpeaking = useCallback(() => {
    Speech.stop();
    setSpeaking(null);
  }, [setSpeaking]);

  const toggleSpeak = useCallback(
    (id: string, text: string) => {
      if (speakingIdRef.current === id) {
        stopSpeaking();
        return;
      }
      Speech.stop(); // stop any other message that is currently being read
      const clean = cleanForSpeech(text).slice(0, Speech.maxSpeechInputLength - 1);
      if (!clean) return;
      // Only clear the "speaking" state if this message is still the active one.
      const done = () => {
        if (speakingIdRef.current === id) setSpeaking(null);
      };
      setSpeaking(id);
      Speech.speak(clean, { language: 'en-US', onDone: done, onStopped: done, onError: done });
    },
    [stopSpeaking, setSpeaking],
  );

  // ---- Voice input ----
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false); // lets the unmount cleanup know if a recording is running
  const [transcribing, setTranscribing] = useState(false);

  const updateRecording = (value: boolean) => {
    recordingRef.current = value;
    setRecording(value);
  };

  // Tap once to start recording, tap again to stop, transcribe on the server, then send.
  async function toggleRecording() {
    if (transcribing || sending || !token) return;
    try {
      if (!recording) {
        const perm = await AudioModule.requestRecordingPermissionsAsync();
        if (!perm.granted) {
          Alert.alert('Permission needed', 'Allow microphone access to use voice input.');
          return;
        }
        stopSpeaking(); // don't record the phone reading a reply aloud
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await recorder.prepareToRecordAsync();
        recorder.record();
        updateRecording(true);
        return;
      }

      updateRecording(false);
      setTranscribing(true);
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false }); // lets read-aloud use the speaker again
      const uri = recorder.uri;
      if (!uri) throw new Error('No recording was saved.');

      // The server expects the audio as base64 inside JSON.
      const audio = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const r = await fetch(`${BACKEND_URL}/api/transcribe`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': 'true',
        },
        body: JSON.stringify({ audio }),
      });
      if (r.status === 401) {
        signOut();
        return;
      }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
      const text = (data.text || '').trim();
      if (!text) {
        Alert.alert('Nothing heard', 'Try again and speak a little closer to the mic.');
        return;
      }
      // Use the refs, not this function's captured values: the user may have typed more,
      // toggled web search, or changed chats while we were transcribing.
      const typed = inputRef.current.trim();
      const combined = typed ? `${typed} ${text}` : text;
      sendMessageRef.current({ text: combined });
    } catch (e: any) {
      updateRecording(false);
      Alert.alert('Voice input failed', e.message);
    } finally {
      setTranscribing(false);
    }
  }

  // ---- Streaming control ----
  // Invalidates the running stream (its callbacks become no-ops) and aborts the request.
  const abortStream = useCallback(() => {
    streamIdRef.current += 1;
    if (xhrRef.current) {
      xhrRef.current.abort();
      xhrRef.current = null;
    }
    setSending(false);
  }, []);

  // When the screen unmounts: cancel any running stream, stop reading aloud,
  // and stop an active recording so the mic isn't left on.
  useEffect(
    () => () => {
      streamIdRef.current += 1;
      xhrRef.current?.abort();
      Speech.stop();
      if (recordingRef.current) {
        recorder.stop().catch(() => {});
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ---- Initial load: conversation list, then the newest conversation's messages ----
  useEffect(() => {
    (async () => {
      if (!token) return;
      try {
        let list = await apiFetch('/api/conversations', {}, token);

        // First-time users get a starter chat.
        if (list.conversations.length === 0) {
          const created = await apiFetch(
            '/api/conversations',
            { method: 'POST', body: JSON.stringify({ title: 'First chat' }) },
            token,
          );
          list = { conversations: [created.conversation] };
        }

        setConversations(list.conversations);
        const id = list.conversations[0].id;
        setConversationId(id);

        // loadSeqRef: if another load starts while this one is in flight, ignore this result.
        const seq = ++loadSeqRef.current;
        const msgs = await apiFetch(`/api/conversations/${id}/messages`, {}, token);
        if (seq === loadSeqRef.current) setMessages(msgs.messages.map(toMessage));
      } catch (e: any) {
        console.warn('Failed to load conversation:', e.message);
      }
    })();
  }, [token]);

  async function openConversation(id: number) {
    if (!token) return;
    setDrawerOpen(false);
    if (id === conversationId) return;
    abortStream();
    atBottomRef.current = true; // force auto-scroll to the bottom once the messages load
    const seq = ++loadSeqRef.current;
    try {
      setConversationId(id);
      setMessages([]);
      const msgs = await apiFetch(`/api/conversations/${id}/messages`, {}, token);
      if (seq === loadSeqRef.current) setMessages(msgs.messages.map(toMessage));
    } catch (e: any) {
      console.warn('Failed to open conversation:', e.message);
    }
  }

  // ---- Create / rename / delete conversations ----
  function promptNewChat() {
    setDrawerOpen(false);
    setNameTargetId(null);
    setNameInput('');
    setNameModalVisible(true);
  }

  function promptRename(id: number, currentTitle: string) {
    setNameTargetId(id);
    setNameInput(currentTitle);
    setNameModalVisible(true);
  }

  // Handles both "create" (nameTargetId === null) and "rename".
  async function submitName() {
    if (!token) return;
    const title = nameInput.trim();
    if (!title) return;

    try {
      if (nameTargetId === null) {
        const created = await apiFetch(
          '/api/conversations',
          { method: 'POST', body: JSON.stringify({ title }) },
          token,
        );
        abortStream();
        loadSeqRef.current += 1; // cancels any in-flight message load for the previous chat
        setConversations((prev) => [created.conversation, ...prev]);
        setConversationId(created.conversation.id);
        setMessages([]);
      } else {
        const updated = await apiFetch(
          `/api/conversations/${nameTargetId}`,
          { method: 'PUT', body: JSON.stringify({ title }) },
          token,
        );
        setConversations((prev) =>
          prev.map((c) => (c.id === nameTargetId ? { ...c, title: updated.conversation.title } : c)),
        );
      }
    } catch (e: any) {
      Alert.alert('Could not save', e.message);
    } finally {
      setNameModalVisible(false);
      setNameTargetId(null);
      setNameInput('');
    }
  }

  function confirmDelete(id: number, title: string) {
    Alert.alert(
      'Delete conversation?',
      `"${title}" and all its messages will be permanently deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteConversation(id) },
      ],
    );
  }

  async function deleteConversation(id: number) {
    if (!token) return;
    try {
      if (id === conversationId) abortStream();
      await apiFetch(`/api/conversations/${id}`, { method: 'DELETE' }, token);

      // Read the latest list from the ref, not from this closure, which may be stale after the await.
      const remaining = conversationsRef.current.filter((c) => c.id !== id);
      setConversations(remaining);

      // If the open chat was deleted, move to another one (or show the empty state).
      if (id === conversationId) {
        if (remaining.length > 0) {
          await openConversation(remaining[0].id);
        } else {
          setConversationId(null);
          setMessages([]);
        }
      }
    } catch (e: any) {
      Alert.alert('Could not delete', e.message);
    }
  }

  // Re-fetches the list (so order and titles update after a reply). Failures are ignored on purpose.
  function refreshConversationList() {
    if (!token) return;
    apiFetch('/api/conversations', {}, token)
      .then((list: any) => setConversations(list.conversations))
      .catch(() => {});
  }

  // ---- Photos ----
  async function pickImage(source: 'camera' | 'library') {
    try {
      if (source === 'camera') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          Alert.alert('Permission needed', 'Allow camera access to take a photo.');
          return;
        }
      }
      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync({ quality: 0.8 })
          : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      // Shrink before upload: phone photos are huge, and the model only needs about 900px.
      // Resizing only one side keeps the aspect ratio.
      const longest = Math.max(asset.width, asset.height);
      const actions =
        longest > MAX_IMAGE_SIDE
          ? [{ resize: asset.width >= asset.height ? { width: MAX_IMAGE_SIDE } : { height: MAX_IMAGE_SIDE } }]
          : [];
      // Always re-encode as JPEG: the server only accepts JPEG.
      const out = await manipulateAsync(asset.uri, actions, {
        compress: 0.7,
        format: SaveFormat.JPEG,
        base64: true,
      });
      if (!out.base64) throw new Error('Could not read the photo.');
      setPendingImage({ uri: out.uri, base64: out.base64 });
    } catch (e: any) {
      Alert.alert('Could not add photo', e.message);
    }
  }

  function showPhotoMenu() {
    Alert.alert('Add a photo', undefined, [
      { text: 'Take photo', onPress: () => pickImage('camera') },
      { text: 'Choose from library', onPress: () => pickImage('library') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  // ---- Sending a message and reading the streamed reply ----
  function sendMessage(overrides?: { text?: string; image?: PendingImage | null }) {
    const text = (overrides?.text ?? input).trim();
    const img = overrides?.image !== undefined ? overrides.image : pendingImage;
    const search = webSearch;
    if ((!text && !img) || sending) return;
    if (!token || !conversationId) {
      Alert.alert('Not ready', 'No conversation is open yet.');
      return;
    }

    // Add the user's message and an empty assistant bubble that the stream will fill in.
    const stamp = Date.now();
    const assistantId = `${stamp}-a`;
    setMessages((prev) => [
      ...prev,
      {
        id: `${stamp}-u`,
        role: 'user',
        content: text,
        imageUri: img?.uri,
      },
      { id: assistantId, role: 'assistant', content: '' },
    ]);
    setInput('');
    setPendingImage(null);
    setSending(true);

    // Each stream gets a number. If the user stops it or switches chat, the number changes and
    // every callback from this stream becomes a no-op via isStale().
    const myStream = ++streamIdRef.current;
    const isStale = () => myStream !== streamIdRef.current;

    // Tokens are collected and applied at most every FLUSH_INTERVAL_MS to avoid re-rendering per token.
    let pending = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!pending || isStale()) {
        pending = '';
        return;
      }
      const add = pending;
      pending = '';
      setMessages((prev) => {
        const i = prev.length - 1;
        // Only touch the last message, and only if it is still our assistant bubble.
        if (i < 0 || prev[i].id !== assistantId) return prev;
        const copy = prev.slice();
        copy[i] = { ...prev[i], content: prev[i].content + add };
        return copy;
      });
    };

    const queueText = (s: string) => {
      pending += s;
      if (!timer) timer = setTimeout(flush, FLUSH_INTERVAL_MS);
    };

    // Shows an error inside the assistant bubble (after any text that already arrived).
    const showError = (msg: string) => {
      flush();
      if (isStale()) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, content: m.content ? `${m.content}\n\n[${msg}]` : msg } : m,
        ),
      );
    };

    // XMLHttpRequest is used instead of fetch because React Native's fetch cannot stream.
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    let lastLength = 0;
    let sseBuf = '';

    // SSE events end with a blank line, but one event can arrive split across two progress
    // callbacks, so keep any unfinished tail in sseBuf until the rest arrives.
    const processProgress = () => {
      if (xhr.status !== 200) return;
      sseBuf += xhr.responseText.slice(lastLength);
      lastLength = xhr.responseText.length;

      let idx: number;
      while ((idx = sseBuf.indexOf('\n\n')) >= 0) {
        const evt = sseBuf.slice(0, idx);
        sseBuf = sseBuf.slice(idx + 2);
        if (!evt.startsWith('data: ')) continue;
        try {
          const parsed = JSON.parse(evt.slice(6));
          if (parsed.error) showError(parsed.error);
          else if (parsed.content) queueText(parsed.content);
        } catch {
          // malformed event; skip it
        }
      }
    };

    xhr.open('POST', `${BACKEND_URL}/api/chat`);
    xhr.timeout = STREAM_TIMEOUT_MS;
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('ngrok-skip-browser-warning', 'true');

    xhr.onprogress = () => {
      if (isStale()) return;
      processProgress();
    };

    xhr.onerror = () => showError("Couldn't reach the server (network error)");
    xhr.ontimeout = () => showError('The request timed out');

    // Runs after success, error, timeout or abort.
    xhr.onloadend = () => {
      if (isStale()) return; // cancelled or replaced: leave state alone
      processProgress();
      flush();

      if (xhr.status === 401) {
        signOut();
      } else if (xhr.status >= 400) {
        let msg = `Request failed (status ${xhr.status})`;
        try {
          msg = JSON.parse(xhr.responseText).error || msg;
        } catch {}
        showError(msg);
      }

      xhrRef.current = null;
      setSending(false);
      refreshConversationList();
    };

    xhr.send(
      JSON.stringify({
        conversationId,
        message: text,
        image: img?.base64,
        webSearch: search,
      }),
    );
  }

  // The list item renderer only changes when something a bubble needs actually changes.
  const renderItem = useCallback(
    ({ item }: { item: Message }) => (
      <MessageBubble
        id={item.id}
        role={item.role}
        content={item.content}
        imageUri={item.imageUri}
        hasImage={item.hasImage}
        token={token}
        canSpeak={item.role === 'assistant'}
        speaking={speakingId === item.id}
        onSpeak={toggleSpeak}
      />
    ),
    [token, speakingId, toggleSpeak],
  );

  // Show "Thinking…" from sending until the first token arrives.
  const waitingForFirstToken = sending && messages[messages.length - 1]?.content === '';

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedView style={styles.headerRow}>
          <Pressable onPress={() => setDrawerOpen(true)} style={styles.headerButton}>
            <ThemedText type="small">☰</ThemedText>
          </Pressable>

          <ThemedText type="small" numberOfLines={1} style={styles.headerTitle}>
            {conversations.find((c) => c.id === conversationId)?.title || 'Chat'}
          </ThemedText>

          <Pressable
            onPress={() => {
              abortStream();
              signOut();
            }}
            style={styles.headerButton}>
            <ThemedText type="small">Sign out</ThemedText>
          </Pressable>
        </ThemedView>

        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? KEYBOARD_OFFSET_IOS : 0}>
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.messageList}
            renderItem={renderItem}
            onScroll={onScroll}
            scrollEventThrottle={16}
            onContentSizeChange={() => {
              // Follow new text only while the user is already at the bottom.
              if (atBottomRef.current) {
                listRef.current?.scrollToEnd({ animated: false });
              }
            }}
            ListEmptyComponent={
              <ThemedView style={styles.emptyState}>
                <ThemedText type="small">Say hello to get started.</ThemedText>
              </ThemedView>
            }
          />
          {waitingForFirstToken && (
            <ThemedView style={styles.typingRow}>
              <ActivityIndicator />
              <ThemedText type="small">Thinking…</ThemedText>
            </ThemedView>
          )}

          {pendingImage && (
            <ThemedView type="backgroundElement" style={styles.previewRow}>
              <Image source={{ uri: pendingImage.uri }} style={styles.previewImage} />
              <Pressable onPress={() => setPendingImage(null)} hitSlop={10}>
                <ThemedText type="small">✕ Remove photo</ThemedText>
              </Pressable>
            </ThemedView>
          )}
          <ThemedView type="backgroundElement" style={styles.inputRow}>
            <Pressable onPress={showPhotoMenu} disabled={sending} style={styles.iconButton}>
              <ThemedText type="small">📷</ThemedText>
            </Pressable>
            <Pressable
              onPress={() => setWebSearch((v) => !v)}
              style={[styles.iconButton, webSearch && styles.iconButtonOn]}>
              <ThemedText type="small">🌐</ThemedText>
            </Pressable>
            <Pressable
              onPress={toggleRecording}
              disabled={sending || transcribing}
              style={[styles.iconButton, recording && styles.iconButtonOn, (sending || transcribing) && { opacity: 0.4 }]}>
              <ThemedText type="small">{transcribing ? '…' : recording ? '⏹' : '🎤'}</ThemedText>
            </Pressable>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder={webSearch ? 'Message Qwen (web search on)' : 'Message Qwen'}
              placeholderTextColor="#888"
              style={[styles.input, { color: colors.text }]}
              multiline
            />
            {/* While a reply is streaming this button becomes "Stop" */}
            <Pressable
              onPress={sending ? abortStream : () => sendMessage()}
              disabled={!sending && !input.trim() && !pendingImage}
              style={[
                styles.sendButton,
                (!sending && !input.trim() && !pendingImage) && { opacity: 0.4 },
              ]}>
              <ThemedText type="code">{sending ? 'Stop' : 'Send'}</ThemedText>
            </Pressable>
          </ThemedView>
        </KeyboardAvoidingView>
      </SafeAreaView>

      {/* Drawer modal: must be a sibling of SafeAreaView so it overlays the whole screen */}
      <Modal
        visible={drawerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setDrawerOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setDrawerOpen(false)} />
        <ThemedView style={styles.drawer}>
          <Pressable onPress={promptNewChat} style={styles.drawerNewChat}>
            <ThemedText type="small">+ New chat</ThemedText>
          </Pressable>

          <FlatList
            data={conversations}
            keyExtractor={(c) => String(c.id)}
            renderItem={({ item }) => (
              <ThemedView style={[styles.drawerRow, item.id === conversationId && styles.drawerItemActive]}>
                <Pressable onPress={() => openConversation(item.id)} style={styles.drawerRowMain}>
                  <ThemedText type="small" numberOfLines={1}>
                    {item.title}
                  </ThemedText>
                </Pressable>

                {/* "⋯" menu: rename or delete */}
                <Pressable
                  onPress={() =>
                    Alert.alert(item.title, undefined, [
                      { text: 'Rename', onPress: () => promptRename(item.id, item.title) },
                      {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: () => confirmDelete(item.id, item.title),
                      },
                      { text: 'Cancel', style: 'cancel' },
                    ])
                  }
                  hitSlop={10}
                  style={styles.drawerRowMenu}>
                  <ThemedText type="small">⋯</ThemedText>
                </Pressable>
              </ThemedView>
            )}
            ListEmptyComponent={
              <ThemedView style={styles.drawerEmpty}>
                <ThemedText type="small">No conversations yet.</ThemedText>
              </ThemedView>
            }
          />
        </ThemedView>
      </Modal>

      {/* Name modal: used for creating and renaming */}
      <Modal
        visible={nameModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setNameModalVisible(false)}>
        <Pressable style={styles.backdrop} onPress={() => setNameModalVisible(false)} />
        <ThemedView type="backgroundElement" style={styles.nameModal}>
          <ThemedText type="small" style={styles.nameModalTitle}>
            {nameTargetId === null ? 'Name your new chat' : 'Rename chat'}
          </ThemedText>
          <TextInput
            value={nameInput}
            onChangeText={setNameInput}
            placeholder="Chat name"
            placeholderTextColor="#888"
            style={[styles.nameInput, { color: colors.text }]}
            autoFocus
            maxLength={100}
            onSubmitEditing={submitName}
          />
          <ThemedView type="backgroundElement" style={styles.nameActions}>
            <Pressable onPress={() => setNameModalVisible(false)} style={styles.nameButton}>
              <ThemedText type="small">Cancel</ThemedText>
            </Pressable>
            <Pressable onPress={submitName} disabled={!nameInput.trim()} style={styles.nameButton}>
              <ThemedText type="small">{nameTargetId === null ? 'Create' : 'Save'}</ThemedText>
            </Pressable>
          </ThemedView>
        </ThemedView>
      </Modal>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  speakButton: { marginTop: 6, alignSelf: 'flex-start' },
  container: { flex: 1 },
  flex: { flex: 1 },
  safeArea: {
    flex: 1,
    alignSelf: 'center',
    width: '100%',
    maxWidth: MaxContentWidth,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  headerButton: {
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two,
    minWidth: 60,
  },
  headerTitle: { flex: 1, textAlign: 'center' },
  messageList: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    gap: Spacing.two,
    flexGrow: 1,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: Spacing.four * 2,
  },
  bubble: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.three,
    maxWidth: '85%',
  },
  userBubble: { alignSelf: 'flex-end' },
  assistantBubble: { alignSelf: 'flex-start' },
  bubbleImage: { width: 200, height: 200, borderRadius: 8, marginBottom: 6 },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  previewImage: { width: 56, height: 56, borderRadius: 8 },
  iconButton: { paddingHorizontal: 8, paddingVertical: 8, borderRadius: 8 },
  iconButtonOn: { backgroundColor: '#8883' },
  typingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
  },
  sendButton: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  drawer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 280,
    paddingTop: Spacing.four,
    paddingHorizontal: Spacing.three,
  },
  drawerNewChat: {
    paddingVertical: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#3333',
  },
  drawerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#3333',
  },
  drawerRowMain: {
    flex: 1,
    paddingVertical: Spacing.three,
    paddingRight: Spacing.two,
  },
  drawerRowMenu: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.three,
    minWidth: 40,
    alignItems: 'center',
  },
  drawerItemActive: {
    backgroundColor: '#8881',
  },
  drawerEmpty: {
    paddingTop: Spacing.three,
    alignItems: 'center',
  },
  nameModal: {
    position: 'absolute',
    top: '30%',
    left: 24,
    right: 24,
    padding: Spacing.four,
    borderRadius: Spacing.three,
  },
  nameModalTitle: {
    marginBottom: Spacing.three,
    fontWeight: '600',
  },
  nameInput: {
    borderWidth: 1,
    borderColor: '#8885',
    borderRadius: 8,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  nameActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.three,
    marginTop: Spacing.three,
  },
  nameButton: {
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
});
