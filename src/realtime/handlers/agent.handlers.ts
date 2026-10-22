import type { SocketHandlerInput } from '../types';
import { agentRealtimeVoiceService } from '../../modules/agent/services/realtime-voice.service';
import { agentSessionService } from '../../modules/agent/services/session.service';
import { getAgentAccessDeniedMessage, getPremiumAccessSnapshot } from '../../modules/premium/services/premium-access.service';

export function registerAgentSocketHandlers({ socket, context }: SocketHandlerInput): void {
  const { getSocketUserId } = context;

  socket.on('agent:join_session', async (payload: any = {}) => {
    const authenticatedUserId = getSocketUserId(socket);
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!authenticatedUserId || !sessionId || sessionId.length > 128) {
      return;
    }

    try {
      await agentSessionService.requireSession(sessionId, authenticatedUserId);
      await socket.join(`agent:session:${sessionId}`);
    } catch {
      socket.emit('agent:session_error', {
        sessionId,
        error: 'Agent session not found',
      });
    }
  });

  socket.on('agent:leave_session', ({ sessionId }) => {
    if (!sessionId) {
      return;
    }
    socket.leave(`agent:session:${sessionId}`);
  });

  socket.on('agent:voice_start', async (payload: any = {}) => {
    const authenticatedUserId = getSocketUserId(socket);
    if (!authenticatedUserId) {
      socket.emit('agent:voice_error', {
        error: 'You need to be signed in to use realtime voice.',
      });
      return;
    }

    try {
      const sessionId = String(payload?.sessionId || '').trim();
      if (!sessionId) {
        socket.emit('agent:voice_error', {
          error: 'An agent session is required before starting realtime voice.',
        });
        return;
      }

      const snapshot = await getPremiumAccessSnapshot(authenticatedUserId);
      if (!snapshot.canUseAgent) {
        socket.emit('agent:voice_error', {
          sessionId,
          error: getAgentAccessDeniedMessage(snapshot),
        });
        return;
      }

      await agentRealtimeVoiceService.startSession({
        socketId: socket.id,
        userId: authenticatedUserId,
        sessionId,
        surface: typeof payload?.surface === 'string' ? payload.surface : undefined,
        surfaceContext:
          payload?.surfaceContext && typeof payload.surfaceContext === 'object' ? payload.surfaceContext : {},
        allowAutonomousActions:
          typeof payload?.allowAutonomousActions === 'boolean' ? payload.allowAutonomousActions : undefined,
        autonomyMode: typeof payload?.autonomyMode === 'string' ? payload.autonomyMode : undefined,
      });
    } catch (error) {
      socket.emit('agent:voice_error', {
        sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : undefined,
        error:
          typeof (error as { userMessage?: unknown } | null | undefined)?.userMessage === 'string'
            ? (error as { userMessage: string }).userMessage
            : error instanceof Error
              ? error.message
              : 'Realtime voice is temporarily unavailable right now.',
      });
    }
  });

  socket.on('agent:voice_audio_chunk', (payload: any = {}) => {
    if (typeof payload?.audioBase64 !== 'string' || !payload.audioBase64) {
      return;
    }
    agentRealtimeVoiceService.appendAudioChunk(socket.id, payload.audioBase64);
  });

  socket.on('agent:surface_update', async (payload: any = {}) => {
    try {
      await agentRealtimeVoiceService.updateSurface({
        socketId: socket.id,
        sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : undefined,
        surface: typeof payload?.surface === 'string' ? payload.surface : undefined,
        surfaceContext:
          payload?.surfaceContext && typeof payload.surfaceContext === 'object' ? payload.surfaceContext : {},
        allowAutonomousActions:
          typeof payload?.allowAutonomousActions === 'boolean' ? payload.allowAutonomousActions : undefined,
        autonomyMode: typeof payload?.autonomyMode === 'string' ? payload.autonomyMode : undefined,
      });
    } catch (error) {
      socket.emit('agent:voice_error', {
        sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : undefined,
        error: error instanceof Error ? error.message : 'Could not sync the current agent surface.',
      });
    }
  });

  socket.on('agent:voice_interrupt', () => {
    agentRealtimeVoiceService.interrupt(socket.id);
  });

  socket.on('agent:voice_prompt', (payload: any = {}) => {
    const instructions =
      typeof payload?.instructions === 'string'
        ? payload.instructions
        : typeof payload?.text === 'string'
          ? payload.text
          : '';
    agentRealtimeVoiceService.prompt(socket.id, instructions);
  });

  socket.on('agent:voice_stop', () => {
    agentRealtimeVoiceService.stopSession(socket.id);
  });
}
