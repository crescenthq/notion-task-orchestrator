import type {OrchestrationUtilities, UtilityResult} from '../orchestration'

export type AskForRepoResult = {
  repo: string
  branch?: string
}

type StructuredAskForRepo = {
  repo?: unknown
  branch?: unknown
}

export async function askForRepo(
  utilities: OrchestrationUtilities,
  prompt: string,
): Promise<UtilityResult<AskForRepoResult>> {
  const result = await utilities.invokeAgent({
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
  if (typeof structured.repo !== 'string' || structured.repo.trim().length === 0) {
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
      branch: typeof structured.branch === 'string' ? structured.branch : undefined,
    },
  }
}
