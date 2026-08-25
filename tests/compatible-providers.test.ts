import { describe, expect, it } from 'vitest';
import { findCompatibleProvider, type CompatibleProvider } from '../src/core/proxy.js';

const providers: CompatibleProvider[] = [
  { modelPrefix: 'deepseek', upstream: 'https://zen.example' },
  { modelPrefix: 'mimo', upstream: 'https://zen.example' },
  { modelPrefix: 'minimax', upstream: 'https://zen-go.example' },
  { modelPrefix: 'moonshotai', upstream: 'https://integrate.api.nvidia.com' },
  { modelPrefix: 'nvidia', upstream: 'https://integrate.api.nvidia.com' },
  { modelPrefix: 'minimaxai', upstream: 'https://integrate.api.nvidia.com' },
  { modelPrefix: 'big-pickle', upstream: 'https://zen.example' },
];

describe('compatible provider matching (SPEC-017)', () => {
  it('routes org-prefixed NVIDIA models to the NVIDIA upstream', () => {
    expect(findCompatibleProvider('moonshotai/kimi-k3', providers)?.upstream).toBe(
      'https://integrate.api.nvidia.com',
    );
    expect(
      findCompatibleProvider('nvidia/nemotron-3.5-lightning-30b-a3b', providers)?.upstream,
    ).toBe('https://integrate.api.nvidia.com');
  });

  it('minimaxai/minimax-m3 wins over the minimax prefix (longest match)', () => {
    const m = findCompatibleProvider('minimaxai/minimax-m3', providers);
    expect(m?.modelPrefix).toBe('minimaxai');
    expect(m?.upstream).toBe('https://integrate.api.nvidia.com');
  });

  it('plain minimax-m3 still matches the minimax GO provider', () => {
    expect(findCompatibleProvider('minimax-m3', providers)?.modelPrefix).toBe('minimax');
    expect(findCompatibleProvider('MiniMax-M3', providers)?.modelPrefix).toBe('minimax');
  });

  it('big-pickle matches its own provider, not the OpenAI fallback', () => {
    expect(findCompatibleProvider('big-pickle', providers)?.modelPrefix).toBe('big-pickle');
  });

  it('existing prefixes keep matching (case-insensitive)', () => {
    expect(findCompatibleProvider('deepseek-v4-flash-free', providers)?.modelPrefix).toBe(
      'deepseek',
    );
    expect(findCompatibleProvider('MiMo-v2.5-free', providers)?.modelPrefix).toBe('mimo');
  });

  it('unknown models match nothing (OpenAI fallback preserved)', () => {
    expect(findCompatibleProvider('gpt-5.6', providers)).toBeUndefined();
    expect(findCompatibleProvider(null, providers)).toBeUndefined();
    expect(findCompatibleProvider(undefined, providers)).toBeUndefined();
    expect(findCompatibleProvider('kimi-k3', providers)).toBeUndefined();
  });
});
