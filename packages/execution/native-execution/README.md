# @deepseek-ai/dsh-native-execution

Service definition for the native execution plane. The seam exposes executable lookup and ordinary managed processes while deliberately excluding Agent, Session, model, permission-policy, shell, PTY, filesystem, and network semantics.

Model-visible impact: none by itself. Consumers decide whether native execution is surfaced through tools. KV-cache impact: none.
