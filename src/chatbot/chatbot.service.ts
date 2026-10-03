import { Injectable, Logger, BadRequestException, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOllama } from '@langchain/ollama';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { FaqService } from '../faq/faq.service';
import { ChatbotMessageDto, ChatbotResponseDto } from './dto/chatbot.dto';
import { RedisService } from '../common/services/redis.service';
import { ChatbotHistory } from './chatbot-history';
import { AIMessage, HumanMessage, SystemMessage, BaseMessage } from '@langchain/core/messages';

@Injectable()
export class ChatbotService {
  private readonly logger = new Logger(ChatbotService.name);
  private readonly llm: ChatOllama;
  private readonly history: ChatbotHistory;

  constructor(
    private readonly configService: ConfigService,
    private readonly faqService: FaqService,
    redis: RedisService,
  ) {
    this.history = new ChatbotHistory(redis, configService.get<string>('JWT_SECRET') || '');
    // Configuration Ollama depuis les variables d'environnement
    const ollamaBaseUrl = this.configService.get<string>('OLLAMA_BASE_URL') || 'http://localhost:11434';
    const model = this.configService.get<string>('OLLAMA_MODEL') || 'llama3.2';

    this.logger.log(`Initializing Ollama chatbot with model: ${model} at ${ollamaBaseUrl}`);

    this.llm = new ChatOllama({
      baseUrl: ollamaBaseUrl,
      model,
      temperature: 0.7,
      numPredict: 512,
      // Optionnel: ajouter d'autres paramètres
      // topP: 0.9,
      // topK: 40,
    });
  }

  async chat(
    userId: string,
    dto: ChatbotMessageDto,
  ): Promise<ChatbotResponseDto> {
    let release: (() => Promise<void>) | undefined;
    try {
      const session = this.history.open(userId, dto.conversationId, dto.conversationToken);
      const conversationId = session.id;
      release = await this.history.acquire(conversationId);
      const history = await this.history.read(session);

      // Récupérer les FAQ pertinentes pour le contexte
      const relevantFaqs = await this.getRelevantFaqs(dto.message);

      // Construire le prompt avec le contexte
      const systemPrompt = this.buildSystemPrompt(relevantFaqs);

      // Récupérer l'historique de conversation

      // Construire le prompt avec historique
      const messages: BaseMessage[] = [new SystemMessage(systemPrompt)];

      // Ajouter l'historique en convertissant les rôles
      history.forEach((msg) => {
        if (msg.role === 'human') {
          messages.push(new HumanMessage(msg.content));
        } else if (msg.role === 'assistant') {
          messages.push(new AIMessage(msg.content));
        }
      });

      // Ajouter le message actuel
      messages.push(new HumanMessage(dto.message));

      const prompt = ChatPromptTemplate.fromMessages(messages);

      // Créer la chaîne de traitement
      const chain = RunnableSequence.from([
        prompt,
        this.llm,
        new StringOutputParser(),
      ]);

      // Appeler le modèle
      const response = await chain.invoke({}, { signal: AbortSignal.timeout(30_000) });

      // Sauvegarder dans l'historique
      await this.history.save(session, [...history,
        { role: 'human', content: dto.message }, { role: 'assistant', content: response }]);

      // Extraire les IDs des FAQ utilisées
      const relatedFaqIds = relevantFaqs.map((faq) => faq.id);

      this.logger.log(`Chatbot response generated for user ${userId}, conversation ${conversationId}`);

      return {
        response: response.trim(),
        conversationId,
        conversationToken: session.conversationToken,
        relatedFaqs: relatedFaqIds.length > 0 ? relatedFaqIds : undefined,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Error in chatbot service: ${error.message}`, error.stack);
      
      // Si Ollama n'est pas disponible, retourner une réponse de fallback
      if (error.message?.includes('ECONNREFUSED') || error.message?.includes('fetch')) {
        throw new BadRequestException(
          'Le service de chatbot est temporairement indisponible. Veuillez réessayer plus tard ou contacter le support.',
        );
      }

      throw new BadRequestException('L’assistant est temporairement indisponible. Réessayez ou contactez le support.');
    } finally {
      await release?.().catch(() => undefined);
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

  async clearConversationHistory(conversationId: string, userId: string): Promise<void> {
    await this.history.clear(conversationId, userId);
  }
}

