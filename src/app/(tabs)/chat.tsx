import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { BACKEND_URL, apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
};

type Conversation = {
  id: number;
  title: string;
  updated_at: string;
};

export default function ChatScreen() {
  const { token, signOut } = useAuth();
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<Message>>(null);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [nameModalVisible, setNameModalVisible] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [nameTargetId, setNameTargetId] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      if (!token) return;
      try {
        let list = await apiFetch('/api/conversations', {}, token);

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

        const msgs = await apiFetch(`/api/conversations/${id}/messages`, {}, token);
        setMessages(
          msgs.messages.map((m: any) => ({
            id: String(m.id),
            role: m.role,
            content: m.content,
          })),
        );
      } catch (e: any) {
        console.warn('Failed to load conversation:', e.message);
      }
    })();
  }, [token]);

  async function openConversation(id: number) {
    if (!token) return;
    setDrawerOpen(false);
    try {
      setConversationId(id);
      setMessages([]);
      const msgs = await apiFetch(`/api/conversations/${id}/messages`, {}, token);
      setMessages(
        msgs.messages.map((m: any) => ({
          id: String(m.id),
          role: m.role,
          content: m.content,
        })),
      );
    } catch (e: any) {
      console.warn('Failed to open conversation:', e.message);
    }
  }

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
          prev.map((c) =>
            c.id === nameTargetId ? { ...c, title: updated.conversation.title } : c,
          ),
        );
      }
    } catch (e: any) {
      console.warn('Failed to save conversation name:', e.message);
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
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteConversation(id),
        },
      ],
    );
  }

  async function deleteConversation(id: number) {
    if (!token) return;
    try {
      await apiFetch(`/api/conversations/${id}`, { method: 'DELETE' }, token);
      const remaining = conversations.filter((c) => c.id !== id);
      setConversations(remaining);

      if (id === conversationId) {
        if (remaining.length > 0) {
          await openConversation(remaining[0].id);
        } else {
          setConversationId(null);
          setMessages([]);
        }
      }
    } catch (e: any) {
      console.warn('Failed to delete conversation:', e.message);
    }
  }

  function refreshConversationList() {
    if (!token) return;
    apiFetch('/api/conversations', {}, token)
      .then((list: any) => setConversations(list.conversations))
      .catch(() => {});
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending) return;
    if (!token || !conversationId) {
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-e`,
          role: 'assistant',
          content: 'Not ready — no conversation yet.',
        },
      ]);
      return;
    }

    const userMessage: Message = { id: `${Date.now()}-u`, role: 'user', content: text };
    const assistantId = `${Date.now()}-a`;
    setMessages((prev) => [
      ...prev,
      userMessage,
      { id: assistantId, role: 'assistant', content: '' },
    ]);
    setInput('');
    setSending(true);

    await new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest();
      let lastLength = 0;

      xhr.open('POST', `${BACKEND_URL}/api/chat`);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('ngrok-skip-browser-warning', 'true');

      xhr.onprogress = () => {
        const newText = xhr.responseText.slice(lastLength);
        lastLength = xhr.responseText.length;

        const chunks = newText.split('\n\n').filter((c) => c.startsWith('data: '));
        for (const chunk of chunks) {
          try {
            const parsed = JSON.parse(chunk.replace('data: ', ''));
            if (parsed.error) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: `Error: ${parsed.error}` } : m,
                ),
              );
              continue;
            }
            if (parsed.content) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: m.content + parsed.content } : m,
                ),
              );
            }
          } catch {
            // partial chunk; ignore
          }
        }
        requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
      };

      xhr.onerror = () => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: "Couldn't reach the server (network error)" }
              : m,
          ),
        );
        resolve();
      };

      xhr.onloadend = () => {
        if (xhr.status !== 200 && xhr.status !== 0) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: `Couldn't reach the server (status ${xhr.status})` }
                : m,
            ),
          );
        }
        setSending(false);
        refreshConversationList();
        resolve();
      };

      xhr.send(JSON.stringify({ conversationId, message: text }));
    });
  }

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedView style={styles.headerRow}>
          <Pressable onPress={() => setDrawerOpen(true)} style={styles.headerButton}>
            <ThemedText type="small">☰</ThemedText>
          </Pressable>

          <ThemedText type="small">
            {conversations.find((c) => c.id === conversationId)?.title || 'Chat'}
          </ThemedText>

          <Pressable onPress={signOut} style={styles.headerButton}>
            <ThemedText type="small">Sign out</ThemedText>
          </Pressable>
        </ThemedView>

        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0}>
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.messageList}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
            renderItem={({ item }) => (
              <ThemedView
                type="backgroundElement"
                style={[
                  styles.bubble,
                  item.role === 'user' ? styles.userBubble : styles.assistantBubble,
                ]}>
                <ThemedText type="small">{item.content}</ThemedText>
              </ThemedView>
            )}
            ListEmptyComponent={
              <ThemedView style={styles.emptyState}>
                <ThemedText type="small">Say hello to get started.</ThemedText>
              </ThemedView>
            }
          />

          {sending && (
            <ThemedView style={styles.typingRow}>
              <ActivityIndicator />
              <ThemedText type="small">Thinking…</ThemedText>
            </ThemedView>
          )}

          <ThemedView type="backgroundElement" style={styles.inputRow}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="Message Qwen"
              style={styles.input}
              multiline
              onSubmitEditing={sendMessage}
            />
            <Pressable
              onPress={sendMessage}
              disabled={sending || !input.trim()}
              style={styles.sendButton}>
              <ThemedText type="code">Send</ThemedText>
            </Pressable>
          </ThemedView>
        </KeyboardAvoidingView>
      </SafeAreaView>

      {/* Drawer modal — must be a sibling of SafeAreaView so it overlays the whole screen */}
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
            <ThemedView
              style={[
                styles.drawerRow,
                item.id === conversationId && styles.drawerItemActive,
              ]}>
              <Pressable
                onPress={() => openConversation(item.id)}
                style={styles.drawerRowMain}>
                <ThemedText type="small" numberOfLines={1}>
                  {item.title}
                </ThemedText>
              </Pressable>

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
                <ThemedText type="small">☰</ThemedText>
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

      {/* Name modal — used for creating and renaming */}
      <Modal
        visible={nameModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setNameModalVisible(false)}>
        <Pressable style={styles.backdrop} onPress={() => setNameModalVisible(false)} />
        <ThemedView style={styles.nameModal}>
          <ThemedText type="small" style={styles.nameModalTitle}>
            {nameTargetId === null ? 'Name your new chat' : 'Rename chat'}
          </ThemedText>
          <TextInput
            value={nameInput}
            onChangeText={setNameInput}
            placeholder="Chat name"
            style={styles.nameInput}
            autoFocus
            onSubmitEditing={submitName}
          />
          <ThemedView style={styles.nameActions}>
            <Pressable
              onPress={() => setNameModalVisible(false)}
              style={styles.nameButton}>
              <ThemedText type="small">Cancel</ThemedText>
            </Pressable>
            <Pressable
              onPress={submitName}
              disabled={!nameInput.trim()}
              style={styles.nameButton}>
              <ThemedText type="small">
                {nameTargetId === null ? 'Create' : 'Save'}
              </ThemedText>
            </Pressable>
          </ThemedView>
        </ThemedView>
      </Modal>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
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
  drawerItem: {
    paddingVertical: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#3333',
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
    backgroundColor: '#fff',
  },
  nameModalTitle: {
    marginBottom: Spacing.three,
    fontWeight: '600',
  },
  nameInput: {
    borderWidth: 1,
    borderColor: '#ccc',
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