import OpenAI from "openai";
import { AgentTurnRequest, AgentVoiceTurnResponse } from "../../types";
import type { AgentOrchestratorServiceContext } from "./orchestrator-context.service";

export async function transcribeAudioOperation(this: AgentOrchestratorServiceContext, params: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
  }): Promise<string> {
    const client = this.getClient();
    const file = await OpenAI.toFile(params.buffer, params.fileName || 'agent-audio.m4a', {
      type: params.mimeType || 'audio/mp4',
    });
    const model = process.env.AGENT_TRANSCRIBE_MODEL || 'gpt-4o-transcribe';
    const transcription = await this.callProvider(
      () =>
        client.audio.transcriptions.create({
          file,
          model,
        }),
      {
        route: 'agent-voice-transcribe',
        model,
      }
    );
    return String((transcription as any).text || '').trim();
  }

export async function synthesizeSpeechOperation(this: AgentOrchestratorServiceContext, text: string): Promise<{ audioBase64: string; audioMimeType: string } | null> {
    if (!text.trim()) {
      return null;
    }

    const client = this.getClient();
    const model = process.env.AGENT_TTS_MODEL || 'gpt-4o-mini-tts';
    const response = await this.callProvider(
      () =>
        client.audio.speech.create({
          input: text.slice(0, 1500),
          model,
          voice: process.env.AGENT_TTS_VOICE || 'shimmer',
          response_format: 'mp3',
        } as any),
      {
        route: 'agent-voice-tts',
        model,
      }
    );
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      audioBase64: buffer.toString('base64'),
      audioMimeType: 'audio/mpeg',
    };
  }

export async function runVoiceTurnOperation(this: AgentOrchestratorServiceContext, params: {
    userId: string;
    sessionId: string;
    turn: AgentTurnRequest;
    audioBuffer: Buffer;
    fileName: string;
    mimeType: string;
    synthesizeAudio?: boolean;
    requestId?: string;
  }): Promise<AgentVoiceTurnResponse> {
    const transcript = await this.transcribeAudio({
      buffer: params.audioBuffer,
      fileName: params.fileName,
      mimeType: params.mimeType,
    });

    const turnResponse = await this.runTurn(
      params.userId,
      params.sessionId,
      {
        ...params.turn,
        inputText: transcript,
      },
      params.requestId
    );

    const audio =
      params.synthesizeAudio === false
        ? null
        : await this.synthesizeSpeech(turnResponse.assistantMessage);

    return {
      ...turnResponse,
      transcript,
      audioBase64: audio?.audioBase64 || null,
      audioMimeType: audio?.audioMimeType || null,
    };
  }
