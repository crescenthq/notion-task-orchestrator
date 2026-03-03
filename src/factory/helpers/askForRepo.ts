import type {Agent, AgentResult} from '../orchestration'

export type AskForRepoResult = {
  repo: string
  branch?: string
}

type StructuredAskForRepo = {
  repo?: unknown
  branch?: unknown
}

type AskForRepoInput = {
  prompt: string
  schema?: Record<string, string>
}

type AskForRepoOutput = {
  structured?: Record<string, unknown>
}

export async function askForRepo(
  agent: Agent<AskForRepoInput, AskForRepoOutput>,
  prompt: string,
): Promise<AgentResult<AskForRepoResult>> {
  const result = await agent.invoke({
    prompt,
    schema: {
      repo: 'string',
      branch: 'string?',
    },
  })

  if (!result.ok) {
    return result
  }

  const structured = (result.value.structured ?? {}) as StructuredAskForRepo
  if (
    typeof structured.repo !== 'string' ||
    structured.repo.trim().length === 0
  ) {
    return {
      ok: false,
      error: {
        code: 'adapter_error',
        message: 'Agent did not return a repo URL',
      },
    }
  }

  return {
    ok: true,
    value: {
      repo: structured.repo,
      branch:
        typeof structured.branch === 'string' ? structured.branch : undefined,
    },
  }
}
