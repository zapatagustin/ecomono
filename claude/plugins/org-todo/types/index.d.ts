export type Todo = {
  file: string
  line: number
  text: string
  kind: 'org' | 'md'
  src: string
}

declare module 'claude-code' {
  interface PluginState {
    'org-todo': { todos: Todo[] }
  }
}
