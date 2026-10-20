@echo off
:: ============================================================
::  API key configuration for pxpipe
::  Edit this file with your keys
:: ============================================================

:: --- Anthropic (Claude) ---
set ANTHROPIC_API_KEY=

:: --- OpenAI (GPT) ---
set OPENAI_API_KEY=

:: --- DeepSeek ---
:: If DEEPSEEK_API_KEY is empty, requests are routed to the OpenCode Zen
:: gateway (https://opencode.ai/zen) and auth is forwarded from OpenCode.
:: DeepSeek V4 Flash Free (deepseek-v4-flash-free) works through this gateway.
set DEEPSEEK_API_KEY=

:: --- MiMo (Xiaomi) ---
:: If MIMO_API_KEY is empty, requests are routed to the OpenCode Zen
:: gateway (https://opencode.ai/zen) and auth is forwarded from OpenCode.
set MIMO_API_KEY=

:: --- Server settings ---
set PORT=47821
set HOST=127.0.0.1

:: --- Models for compression (comma-separated) ---
:: set PXPIPE_MODELS=claude-fable-5,gpt-5.6,deepseek-v4-pro,deepseek-v4-flash,deepseek-v4-flash-free,mimo-v2.5-pro
