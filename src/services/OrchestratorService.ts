import { Message } from '../contexts/ConversationContext';
import { liveKitVoiceService } from '../services/livekit/LiveKitVoiceService';
import { queryPinecone } from './pineconeClient';
import statutesData from '../data/statutes.json';
import {
  LLMClient,
  UnifiedLLMClient
} from './llmClients';
import { toolManager } from './ToolManager';

type InputType = 'voice' | 'text' | 'ui';

interface OrchestratorInput {
  userId: string;
  type: InputType;
  content: string;
  metadata?: Record<string, any>;
}

interface OrchestratorResponse {
  userId: string;
  type: 'text' | 'voice' | 'action';
  content: string;
  metadata?: Record<string, any>;
}

type ResponseListener = (response: OrchestratorResponse) => void;

interface Statute {
  code: string;
  title: string;
  text: string;
}

interface MirandaLog {
  timestamp: number;
  language: string;
  text: string;
}

class OrchestratorService {
  private lastEmitted: number = 0;
  private conversationHistories: Record<string, Message[]> = {};
  private listeners: Record<string, ResponseListener[]> = {};
  private llmClient: LLMClient;

  private statutes: Statute[] = [];
  private mirandaLogs: Record<string, MirandaLog[]> = {};

  constructor() {
    console.log('[Orchestrator] Initialized');
    this.llmClient = new UnifiedLLMClient('quasar-alpha');

    this.statutes = statutesData as Statute[];
    this.statutes = statutesData as Statute[];
    this.statutes = statutesData as Statute[];
    this.statutes = statutesData as Statute[];
  }

  onResponse(userId: string, listener: ResponseListener) {
    if (!this.listeners[userId]) {
      this.listeners[userId] = [];
    }
    this.listeners[userId].push(listener);
  }

  offResponse(userId: string, listener: ResponseListener) {
    if (!this.listeners[userId]) return;
    this.listeners[userId] = this.listeners[userId].filter(l => l !== listener);
  }

  emitResponse(response: OrchestratorResponse) {
    const listeners = this.listeners[response.userId] || [];
    listeners.forEach(listener => listener(response));
  }

  receiveInput(input: OrchestratorInput): void {
    console.log('[Orchestrator] Received input:', input);

    if (!this.conversationHistories[input.userId]) {
      this.conversationHistories[input.userId] = [];
    }

    this.conversationHistories[input.userId].push({
      role: input.type === 'ui' ? 'system' : 'user',
      content: input.content,
      timestamp: Date.now(),
    });

    this.processInput(input);
  }

  // Handler map for modular action routing (shorter, arrow functions)
  private actionHandlers: Record<string, (i: OrchestratorInput, a: any) => Promise<void> | void> = {
    statute_search: (i) => this.handleStatuteSearch(i.userId, i.content),
    miranda: (i, a) => this.handleMiranda(i.userId, a.language || 'english'),
    tool_use: async (i, a) => this.invokeTool(i, await this.classifyIntent(i), a),
    llm_response: async (i, a) => {
      const reply = await this.routeToLLM(i, await this.classifyIntent(i), a);
      this.emitResponse({ userId: i.userId, type: 'text', content: reply });
      this.speakWithLiveKit(i.userId, reply);
    }
  };

  private async processInput(input: OrchestratorInput): Promise<void> {
    try {
      const intent = await this.classifyIntent(input);
      const action = await this.decideNextAction(input, intent);
      await (this.actionHandlers[action.type] || this.actionHandlers.llm_response).call(this, input, action);
    } catch (error) {
      console.error('[Orchestrator] Handler error:', error);
      this.emitResponse({
        userId: input.userId,
        type: 'text',
        content: 'Sorry, I encountered an error processing your request. Please try again.',
      });
    }
  }

  private async classifyIntent(input: OrchestratorInput): Promise<string> {
    // Placeholder: Replace with ML/LLM-based intent classification
    const text = input.content.toLowerCase();
    if (text.includes('search') || text.includes('find') || text.includes('statute') || text.includes('law')) return 'search';
    if (text.includes('miranda')) return 'miranda';
    // Future: add more intents like 'translate', 'dispatch', 'report', 'tool_use'
    return 'general';
  }

  private async decideNextAction(input: OrchestratorInput, intent: string): Promise<any> {
    // Placeholder: Expand with context-aware decision logic
    if (intent === 'search') {
      return { type: 'statute_search' };
    }
    if (intent === 'miranda') {
      return { type: 'miranda', language: 'english' }; // Future: parse language
    }
    // Future: add tool use decision here
    return { type: 'llm_response' };
  }

  private async routeToLLM(input: OrchestratorInput, intent: string, action: any): Promise<string> {
    console.log('[Orchestrator] routeToLLM called with:', { input, intent, action });
    const retrievedSnippets = await this.retrieveKnowledge(input.content);
    const history = this.conversationHistories[input.userId] || [];
    const mappedHistory = history.map(m => ({ role: m.role, content: m.content }));

    const selected = this.selectLLM(intent);
    console.log(`[Orchestrator] Routing to LLM: ${selected.name}`, { mappedHistory, retrievedSnippets });

    const reply = await selected.client.generateReply(input.userId, mappedHistory, retrievedSnippets);
    console.log('[Orchestrator] LLM reply:', reply);
    return reply;
  }

  private selectLLM(intent: string): { name: string; client: LLMClient } {
    // Use Quasar Alpha via OpenRouter for all LLM responses
    return { name: 'QuasarAlpha', client: this.llmClient };
  }

  private async invokeTool(input: OrchestratorInput, intent: string, action: any): Promise<void> {
    try {
      // For now, parse toolId and params from input content as JSON or fallback
      let toolId = 'fetch_weather';
      let params: Record<string, any> = {};

      try {
        const parsed = JSON.parse(input.content);
        toolId = parsed.toolId || toolId;
        params = parsed.params || {};
      } catch {
        // Not JSON, fallback to default tool or parse heuristically
        if (input.content.toLowerCase().includes('weather')) {
          toolId = 'fetch_weather';
          params.city = input.content.replace(/.*weather in/i, '').trim() || 'New Orleans';
        } else if (input.content.toLowerCase().includes('zapier')) {
          toolId = 'trigger_zapier';
          params.url = 'https://hooks.zapier.com/hooks/catch/123456/abcde'; // Example URL
          params.payload = { message: input.content };
        }
      }

      const result = await toolManager.invokeTool(toolId, params);

      const response: OrchestratorResponse = {
        userId: input.userId,
        type: 'text',
        content: result,
      };
      this.emitResponse(response);
    } catch (error) {
      console.error('[Orchestrator] Tool invocation error:', error);
      const response: OrchestratorResponse = {
        userId: input.userId,
        type: 'text',
        content: 'Sorry, I encountered an error executing the tool.',
      };
      this.emitResponse(response);
    }
  }

  private parseIntent(text: string): string | null {
    const lower = text.toLowerCase();
    if (lower.includes('search') || lower.includes('find') || lower.includes('statute') || lower.includes('law')) return 'search';
    if (lower.includes('miranda')) return 'miranda';
    return null;
  }

  private handleStatuteSearch(userId: string, query: string) {
    const lowerQuery = query.toLowerCase();

    const match = this.statutes.find(s =>
      lowerQuery.includes(s.code.toLowerCase()) ||
      lowerQuery.includes(s.title.toLowerCase())
    );

    let responseText: string;

    if (match) {
      responseText = `${match.code} - ${match.title}: ${match.text}`;
    } else {
      responseText = 'Sorry, I could not find a relevant statute.';
    }

    const response: OrchestratorResponse = {
      userId,
      type: 'text',
      content: responseText,
    };

    this.emitResponse(response);
    this.speakWithLiveKit(userId, responseText, true);
  }

  private async handleMiranda(userId: string, language: string) {
    const mirandaEnglish = "You have the right to remain silent. Anything you say can and will be used against you in a court of law. You have the right to an attorney. If you cannot afford an attorney, one will be provided for you. Do you understand these rights?";

    const translated = language === 'english'
      ? mirandaEnglish
      : `[${language.toUpperCase()} TRANSLATION NOT AVAILABLE]: ${mirandaEnglish}`;

    // Log the Miranda delivery
    if (!this.mirandaLogs[userId]) {
      this.mirandaLogs[userId] = [];
    }
    this.mirandaLogs[userId].push({
      timestamp: Date.now(),
      language,
      text: translated,
    });

    const response: OrchestratorResponse = {
      userId,
      type: 'text',
      content: translated,
      metadata: {
        workflow: 'miranda',
        language,
        timestamp: Date.now(),
      },
    };

    this.emitResponse(response);
    this.speakWithLiveKit(userId, translated);
  }


  private async retrieveKnowledge(query: string): Promise<string[]> {
    // Temporary fix: disable Pinecone retrieval to avoid errors
    return [];
  }


  private async speakWithLiveKit(userId: string, text: string, forceLiveKit: boolean = false) {
    try {
      await liveKitVoiceService.speak(text, 'ash', undefined, forceLiveKit);

      const voiceResponse: OrchestratorResponse = {
        userId,
        type: 'voice',
        content: text,
      };

      this.emitResponse(voiceResponse);
    } catch (error) {
      console.error('[Orchestrator] LiveKit TTS error:', error);
    }
  }

  getHistory(userId: string): Message[] {
    return this.conversationHistories[userId] || [];
  }

  getMirandaLogs(userId: string): MirandaLog[] {
    return this.mirandaLogs[userId] || [];
  }
}

export const orchestratorService = new OrchestratorService();