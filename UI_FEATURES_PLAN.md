# Plano UI: footer usage, ctx meter, silent tools

## Objetivo

Deixar o pi-pane mais limpo e informativo:

- footer mostra subscription, limite de 5h, porcentagem e reset
- footer mostra uso de contexto
- tool calls não mostram output no chat
- chat mostra só pills/status das tools

---

## 1. Footer usage

### Visual final

```txt
◆ Pro  ▰▰▰▰▰▱▱▱  62%  3.1/5h  ↻1h18m
```

### Estados

Normal:

```txt
◆ Pro  ▰▰▰▰▰▱▱▱  62%  3.1/5h  ↻1h18m
```

Alto uso:

```txt
◆ Pro  ▰▰▰▰▰▰▰▱  87%  4.4/5h  ↻42m
```

Crítico:

```txt
◆ Pro  ▰▰▰▰▰▰▰▰  96%  4.8/5h  ↻12m
```

Sem dados:

```txt
◆ Usage unavailable
```

### Cores

- `◆ Pro`: accent ou muted
- barra normal: muted
- 70% a 89%: warning se existir, senão accent
- 90%+: error
- porcentagem: destaque leve
- `3.1/5h`: muted
- reset: dim

### Responsivo

Largo:

```txt
◆ Pro  ▰▰▰▰▰▱▱▱  62%  3.1/5h  ↻1h18m
```

Médio:

```txt
◆ Pro ▰▰▰▰▰▱ 62% ↻1h18m
```

Curto:

```txt
◆ Pro 62%
```

---

## 2. Footer ctx meter

### Visual final

```txt
ctx ▰▰▰▰▱▱ 48%
```

Footer completo:

```txt
◆ Pro ▰▰▰▰▰▱▱▱ 62% 3.1/5h ↻1h18m   ctx ▰▰▰▰▱▱ 48%
```

### Estados

Normal:

```txt
ctx ▰▰▰▰▱▱ 48%
```

Alto:

```txt
ctx ▰▰▰▰▰▱ 78%
```

Crítico:

```txt
ctx ▰▰▰▰▰▰ 94%
```

Sem dados:

```txt
ctx unknown
```

### Cores

- <70%: muted
- 70% a 89%: warning/accent
- 90%+: error

---

## 3. Silent tool calls

### Meta

Esconder output da tool call no chat. Nada de primeiras linhas, stdout, diffs, JSON ou preview.

O modelo continua recebendo o resultado da tool. Só a UI fica silenciosa.

### Visual no chat

Durante execução:

```txt
tools  [exec ● 12s]
```

Múltiplas:

```txt
tools  [exec ● 12s] [grep ✓ 0.1s] [patch …]
```

Erro:

```txt
tools  [typecheck × 4.2s]  failed
```

Finalizado:

```txt
tools  3 done · 13.5s
```

### Estados

```txt
… pending
● running
✓ done
× error
```

### Regras de duração

- pending: aparece quando tool foi chamada, antes de executar
- running: timer atualiza a cada 1s
- success: fica 2s a 4s, depois compacta/some
- error: fica até próximo input ou novo turn
- tools <300ms: evitar flicker, mostrar só success curto
- muitas tools: mostrar 2 ou 3 pills + `+N`

---

## 4. Tool name aliases

Mapear nomes longos para nomes curtos.

```txt
exec_command                → exec
functions.exec_command      → exec
apply_patch                 → patch
ffgrep                      → grep
fffind                      → find
web_search                  → search
web_fetch                   → fetch
context7_query-docs         → docs
context7_resolve-library-id → docs id
document_parse              → parse
document_search             → doc search
document_screenshot         → shot
```

Fallback:

```txt
tool_name_long → tool_name…
```

---

## 5. Layout final

### Normal

```txt
tools  [exec ● 12s] [grep ✓ 0.1s]
┌────────────────────────────────────────────┐
  pi
└────────────────────────────────────────────┘
◆ Pro ▰▰▰▰▰▱▱▱ 62% 3.1/5h ↻1h18m   ctx ▰▰▰▰▱▱ 48%
```

### Sem tools ativas

```txt
┌────────────────────────────────────────────┐
  pi
└────────────────────────────────────────────┘
◆ Pro ▰▰▰▰▰▱▱▱ 62% 3.1/5h ↻1h18m   ctx ▰▰▰▰▱▱ 48%
```

### Tela estreita

```txt
tools  1 running · 2 done
┌──────────────────────┐
  pi
└──────────────────────┘
◆ Pro 62%   ctx 48%
```

---

## 6. Implementação proposta

### Arquivos novos

```txt
src/usage.ts
src/context-meter.ts
src/tool-activity.ts
src/footer.ts
```

### Arquivos alterados

```txt
src/index.ts
src/editor.ts
src/visual.ts
src/utils.ts
```

---

## 7. Componentes internos

### `usage.ts`

Responsável por:

- plan name
- limite de 5h
- horas usadas
- porcentagem
- reset ETA
- fallback unknown

Interface:

```ts
interface UsageSnapshot {
  plan: string;
  usedMs: number;
  limitMs: number;
  resetInMs?: number;
  resetAt?: number;
  available: boolean;
}
```

### `context-meter.ts`

Responsável por:

- porcentagem de contexto usado
- total/max se disponível
- fallback unknown

Interface:

```ts
interface ContextSnapshot {
  percent?: number;
  usedTokens?: number;
  maxTokens?: number;
  available: boolean;
}
```

### `tool-activity.ts`

Responsável por:

- registrar tool call
- atualizar running/done/error
- calcular duração
- renderizar pills
- esconder output original

Interface:

```ts
type ToolStatus = "pending" | "running" | "success" | "error";

interface ToolActivity {
  id: string;
  name: string;
  alias: string;
  status: ToolStatus;
  startedAt?: number;
  endedAt?: number;
  isError?: boolean;
}
```

### `footer.ts`

Responsável por montar:

```txt
usage left + ctx right
```

Com truncamento responsivo.

---

## 8. Ponto técnico principal

Pi usa `ToolExecutionComponent` para renderizar tool rows.

Plano:

1. Patchar renderização de `ToolExecutionComponent`
2. Fazer render retornar só linha compacta
3. Nunca renderizar result output
4. Manter dados reais intactos para o agente
5. Usar eventos de tool para alimentar estado visual

Render final por tool batch:

```txt
tools  [exec ● 12s] [grep ✓ 0.1s]
```

---

## 9. Eventos necessários

Usar eventos disponíveis:

- `tool_call`: criar/atualizar pending
- início da execução: marcar running se disponível
- tool result/end: marcar success/error
- `turn_start`: limpar histórico antigo
- `turn_end`: compactar/sumir success
- input do usuário: limpar erros persistentes

Se pi não expuser início/fim direto em extensão, fallback:

- tool_call = running
- result detectado via componente = success/error
- timer via local state

---

## 10. Ordem de implementação

### Fase 1: render helpers

- criar barra `▰▱`
- criar formatter de percent
- criar formatter de duração
- criar truncamento responsivo
- adicionar aliases de tool

### Fase 2: footer básico

- renderizar usage mockado
- renderizar ctx mockado
- encaixar abaixo do editor
- testar larguras

### Fase 3: dados reais

- descobrir fonte real de subscription/5h
- ligar adapter
- descobrir fonte real de context usage
- ligar adapter
- fallback seguro se dados ausentes

### Fase 4: silent tools

- patchar `ToolExecutionComponent`
- esconder output
- renderizar pill simples
- validar success/error/running

### Fase 5: tool rail agrupada

- juntar tools do mesmo batch
- limitar por largura
- `+N` quando overflow
- manter error persistente

### Fase 6: polish

- cores por estado
- sem flicker em tools rápidas
- timers 1s
- typecheck
- README update com screenshots/text preview

---

## 11. Riscos

- Fonte de subscription/5h pode não estar exposta pela API do pi.
  - Solução: adapter com fallback e opção env/config.

- Context usage pode não estar disponível sempre.
  - Solução: `ctx unknown`.

- Patch de `ToolExecutionComponent` é frágil se pi mudar internals.
  - Solução: checar shape antes de patchar, warning silencioso se incompatível.

- Muitas tools paralelas podem estourar largura.
  - Solução: pills limitadas + resumo.

---

## 12. Decisões fechadas

- Footer contém porcentagem.
- Usage visual usa ASCII:
  ```txt
  ◆ Pro ▰▰▰▰▰▱▱▱ 62% 3.1/5h ↻1h18m
  ```
- Context meter:
  ```txt
  ctx ▰▰▰▰▱▱ 48%
  ```
- Tool output escondido.
- Chat mostra só indicação de chamada, ativa ou concluída.
- Tool activity pills ficam na tela do chat, acima do input.
