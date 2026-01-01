import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOllama } from '@langchain/ollama';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { FaqService } from '../faq/faq.service';
import { ChatbotMessageDto, ChatbotResponseDto } from './dto/chatbot.dto';

@Injectable()
export class ChatbotService {
  private readonly logger = new Logger(ChatbotService.name);
  private readonly llm: ChatOllama;
  private readonly conversationHistory: Map<string, Array<{ role: string; content: string }>> = new Map();
  private readonly maxHistoryLength = 10; // Garder les 10 derniers messages

  constructor(
    private readonly configService: ConfigService,
    private readonly faqService: FaqService,
  ) {
    // Configuration Ollama depuis les variables d'environnement
    const ollamaBaseUrl = this.configService.get<string>('OLLAMA_BASE_URL') || 'http://localhost:11434';
    const model = this.configService.get<string>('OLLAMA_MODEL') || 'llama3.2';

    this.logger.log(`Initializing Ollama chatbot with model: ${model} at ${ollamaBaseUrl}`);

    this.llm = new ChatOllama({
      baseUrl: ollamaBaseUrl,
      model,
      temperature: 0.7,
      // Optionnel: ajouter d'autres paramètres
      // topP: 0.9,
      // topK: 40,
    });
  }

  async chat(
    userId: string,
    dto: ChatbotMessageDto,
  ): Promise<ChatbotResponseDto> {
    try {
      const conversationId = dto.conversationId || `conv-${userId}-${Date.now()}`;

      // Récupérer les FAQ pertinentes pour le contexte
      const relevantFaqs = await this.getRelevantFaqs(dto.message);

      // Construire le prompt avec le contexte
      const systemPrompt = this.buildSystemPrompt(relevantFaqs);

      // Récupérer l'historique de conversation
      const history = this.getConversationHistory(conversationId);

      // Construire le prompt avec historique
      const messages: Array<['system' | 'human' | 'ai', string]> = [
        ['system', systemPrompt],
      ];

      // Ajouter l'historique en convertissant les rôles
      history.forEach((msg) => {
        if (msg.role === 'human') {
          messages.push(['human', msg.content]);
        } else if (msg.role === 'assistant') {
          messages.push(['ai', msg.content]);
        }
      });

      // Ajouter le message actuel
      messages.push(['human', '{input}']);

      const prompt = ChatPromptTemplate.fromMessages(messages);

      // Créer la chaîne de traitement
      const chain = RunnableSequence.from([
        prompt,
        this.llm,
        new StringOutputParser(),
      ]);

      // Appeler le modèle
      const response = await chain.invoke({
        input: dto.message,
      });

      // Sauvegarder dans l'historique
      this.addToHistory(conversationId, 'human', dto.message);
      this.addToHistory(conversationId, 'assistant', response);

      // Extraire les IDs des FAQ utilisées
      const relatedFaqIds = relevantFaqs.map((faq) => faq.id);

      this.logger.log(`Chatbot response generated for user ${userId}, conversation ${conversationId}`);

      return {
        response: response.trim(),
        conversationId,
        relatedFaqs: relatedFaqIds.length > 0 ? relatedFaqIds : undefined,
      };
    } catch (error) {
      this.logger.error(`Error in chatbot service: ${error.message}`, error.stack);
      
      // Si Ollama n'est pas disponible, retourner une réponse de fallback
      if (error.message?.includes('ECONNREFUSED') || error.message?.includes('fetch')) {
        throw new BadRequestException(
          'Le service de chatbot est temporairement indisponible. Veuillez réessayer plus tard ou contacter le support.',
        );
      }

      throw new BadRequestException(
        `Erreur lors de la génération de la réponse: ${error.message}`,
      );
    }
  }

  private async getRelevantFaqs(query: string): Promise<Array<{ id: string; question: string; answer: string }>> {
    try {
      // Rechercher dans les FAQ avec une recherche textuelle
      const faqResult = await this.faqService.findAll(
        {
          search: query,
          page: 1,
          limit: 5, // Limiter à 5 FAQ pertinentes
        },
        false, // Seulement les FAQ publiées
      );

      return faqResult.data.map((faq) => ({
        id: faq.id,
        question: faq.question,
        answer: faq.answer,
      }));
    } catch (error) {
      this.logger.warn(`Error fetching relevant FAQs: ${error.message}`);
      return [];
    }
  }

  private buildSystemPrompt(relevantFaqs: Array<{ question: string; answer: string }>): string {
    let prompt = `Tu es un assistant virtuel pour Zwanga, une plateforme de covoiturage en République Démocratique du Congo.
Tu dois aider les utilisateurs avec leurs questions sur la plateforme de manière amicale, professionnelle et concise.

Instructions importantes:
- Réponds toujours en français
- Sois concis et direct dans tes réponses
- Si tu ne connais pas la réponse, dirige l'utilisateur vers le support
- Utilise les informations des FAQ fournies ci-dessous pour répondre aux questions
- Ne mentionne pas que tu es un modèle d'IA, présente-toi simplement comme l'assistant Zwanga
`;

    if (relevantFaqs.length > 0) {
      prompt += '\n\nFAQ pertinentes:\n';
      relevantFaqs.forEach((faq, index) => {
        prompt += `\n${index + 1}. Q: ${faq.question}\n   R: ${faq.answer}\n`;
      });
    }

    prompt += `\n\nSi la question de l'utilisateur correspond à une FAQ ci-dessus, utilise cette information pour répondre.
Sinon, réponds de manière générale en te basant sur tes connaissances sur les plateformes de covoiturage.`;

    return prompt;
  }

  private getConversationHistory(conversationId: string): Array<{ role: string; content: string }> {
    return this.conversationHistory.get(conversationId) || [];
  }

  private addToHistory(conversationId: string, role: string, content: string): void {
    if (!this.conversationHistory.has(conversationId)) {
      this.conversationHistory.set(conversationId, []);
    }

    const history = this.conversationHistory.get(conversationId)!;
    history.push({ role, content });

    // Limiter la taille de l'historique
    if (history.length > this.maxHistoryLength * 2) {
      // Garder seulement les derniers messages (alternance human/assistant)
      const recentHistory = history.slice(-this.maxHistoryLength * 2);
      this.conversationHistory.set(conversationId, recentHistory);
    }
  }

  /**
   * Nettoie l'historique d'une conversation (utile pour libérer la mémoire)
   */
  clearConversationHistory(conversationId: string): void {
    this.conversationHistory.delete(conversationId);
    this.logger.log(`Cleared conversation history for ${conversationId}`);
  }

  /**
   * Nettoie les anciennes conversations (plus de 24h)
   */
  cleanupOldConversations(): void {
    // Cette méthode peut être appelée périodiquement pour nettoyer l'historique
    // Pour l'instant, on garde tout en mémoire, mais on pourrait ajouter un timestamp
    this.logger.log('Cleanup old conversations called');
  }
}

