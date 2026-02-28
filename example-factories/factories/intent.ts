import {spawnSync} from 'node:child_process'
import {access, mkdir} from 'node:fs/promises'
import {homedir} from 'node:os'
import path from 'node:path'

const FACTORY_ID = 'intent'
const WORKSPACE_ROOT = path.join(
  homedir(),
  '.config',
  'notionflow',
  'workspaces',
  FACTORY_ID,
)
const DEFAULT_TIMEOUT_MS = 120_000
const PLAN_TIMEOUT_MS = 10 * 60_000
const IMPLEMENT_TIMEOUT_MS = 20 * 60_000
const MAX_MESSAGE_LENGTH = 1800

const asText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : ''

const clipText = (value: string, maxLength = MAX_MESSAGE_LENGTH): string => {
  const text = String(value ?? '').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 3)}...`
}

const toSafeSegment = (value: string): string => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return normalized || 'item'
}

const stripTrailingPunctuation = (value: string): string =>
  value.replace(/[),.;!?]+$/g, '').trim()

const normalizeRepoUrl = (raw: string): string => {
  const input = stripTrailingPunctuation(
    raw.replace(/^['"`]+|['"`]+$/g, '').trim(),
  )
  if (!input) return ''

  const directUrlMatch = input.match(/(https?:\/\/\S+|ssh:\/\/\S+|git@\S+)/i)
  if (directUrlMatch?.[1]) return stripTrailingPunctuation(directUrlMatch[1])

  if (/^github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(\.git)?$/i.test(input)) {
    return `https://${input.replace(/\.git$/i, '')}.git`
  }

  const shorthandMatch = input.match(/^([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)$/)
  if (shorthandMatch?.[1]) return `https://github.com/${shorthandMatch[1]}.git`

  return ''
}

const repoNameFromUrl = (repoUrl: string): string => {
  const cleaned = repoUrl.replace(/\/+$/g, '').trim()
  if (!cleaned) return 'repo'

  const sshTail =
    cleaned.startsWith('git@') && cleaned.includes(':')
      ? cleaned.split(':').slice(1).join(':')
      : cleaned
  const parts = sshTail.split('/').filter(Boolean)
  const last = parts[parts.length - 1] ?? 'repo'
  return last.replace(/\.git$/i, '') || 'repo'
}

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

type CommandOptions = {
  cwd?: string
  input?: string
  timeoutMs?: number
}

type CommandResult = {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

const runCommand = (
  command: string,
  args: string[],
  options: CommandOptions = {},
): CommandResult => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf-8',
    input: options.input,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024 * 10,
  })

  const stdout = String(result.stdout ?? '').trim()
  const stderr = String(result.stderr ?? '').trim()
  const code = typeof result.status === 'number' ? result.status : 1

  if (result.error) {
    return {
      ok: false,
      code,
      stdout,
      stderr: result.error.message || stderr || 'command failed',
    }
  }

  return {ok: code === 0, code, stdout, stderr}
}

const parseJsonObject = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return null
  }
  return null
}

const parsePlanDecision = (
  raw: string,
): {decision: 'approve' | 'revise' | 'clarify'; notes: string} => {
  const reply = raw.trim()
  const lower = reply.toLowerCase()

  if (
    lower.startsWith('approve plan') ||
    lower === 'approve' ||
    lower === 'approved' ||
    lower.startsWith('approve')
  ) {
    return {decision: 'approve', notes: ''}
  }

  const revise = reply.match(/^\s*revise(\s+plan)?\s*[:-]?\s*(.*)$/i)
  if (revise) {
    return {
      decision: 'revise',
      notes: asText(revise[2]) || reply,
    }
  }

  return {decision: 'clarify', notes: ''}
}

const parseReviewDecision = (
  raw: string,
): {decision: 'approve' | 'revise' | 'clarify'; notes: string} => {
  const reply = raw.trim()
  const lower = reply.toLowerCase()

  if (
    lower.startsWith('approve changes') ||
    lower === 'approve' ||
    lower === 'approved' ||
    lower.startsWith('approve')
  ) {
    return {decision: 'approve', notes: ''}
  }

  const revise = reply.match(/^\s*revise(\s+changes)?\s*[:-]?\s*(.*)$/i)
  if (revise) {
    return {
      decision: 'revise',
      notes: asText(revise[2]) || reply,
    }
  }

  return {decision: 'clarify', notes: ''}
}

type CodexPlanResult = {
  ok: boolean
  plan: string
  error: string
}

const runCodexPlan = (
  repoDir: string,
  featureRequest: string,
  currentPlan: string,
  revisionNotes: string,
): CodexPlanResult => {
  const prompt = [
    'You are planning implementation work in an existing repository.',
    'Produce a concise, practical plan in markdown.',
    '',
    `Feature request: ${featureRequest}`,
    currentPlan ? 'Current plan draft:' : '',
    currentPlan || '',
    revisionNotes ? 'User revision notes:' : '',
    revisionNotes || '',
    '',
    'Required sections:',
    '1) Goal',
    '2) Files likely to change',
    '3) Step-by-step implementation',
    '4) Risks and edge cases',
    '5) Validation steps',
  ]
    .filter(Boolean)
    .join('\n')

  let result = runCommand('codex', ['run', prompt], {
    cwd: repoDir,
    timeoutMs: PLAN_TIMEOUT_MS,
  })

  if (!result.ok || !result.stdout) {
    const fallback = runCommand('codex', ['run'], {
      cwd: repoDir,
      input: prompt,
      timeoutMs: PLAN_TIMEOUT_MS,
    })
    if (fallback.ok && fallback.stdout) {
      result = fallback
    }
  }

  if (!result.ok || !result.stdout) {
    return {
      ok: false,
      plan: '',
      error:
        result.stderr ||
        result.stdout ||
        `codex exited with code ${result.code}`,
    }
  }

  return {
    ok: true,
    plan: result.stdout.trim(),
    error: '',
  }
}

type ClaudeResult = {
  ok: boolean
  summary: string
  checks: string
  error: string
}

const runClaude = (repoDir: string, prompt: string): ClaudeResult => {
  const result = runCommand(
    'env',
    ['-u', 'CLAUDECODE', 'claude', '--print', '--output-format', 'json'],
    {
      cwd: repoDir,
      input: prompt,
      timeoutMs: IMPLEMENT_TIMEOUT_MS,
    },
  )

  if (!result.ok) {
    return {
      ok: false,
      summary: '',
      checks: '',
      error:
        result.stderr ||
        result.stdout ||
        `claude exited with code ${result.code}`,
    }
  }

  const parsed = parseJsonObject(result.stdout)
  if (parsed) {
    const status = asText(parsed.status).toLowerCase()
    const summary =
      asText(parsed.summary) ||
      asText(parsed.message) ||
      result.stdout ||
      'Claude completed.'
    const checks = asText(parsed.checks)
    if (status === 'failed') {
      return {
        ok: false,
        summary: '',
        checks,
        error: summary || 'Claude reported failure',
      }
    }
    return {
      ok: true,
      summary,
      checks,
      error: '',
    }
  }

  if (!result.stdout) {
    return {
      ok: false,
      summary: '',
      checks: '',
      error: 'Claude returned empty output',
    }
  }

  return {
    ok: true,
    summary: result.stdout,
    checks: '',
    error: '',
  }
}

const buildClaudePrompt = (
  featureRequest: string,
  planText: string,
  revisionNotes: string,
): string =>
  [
    'You are editing the current git repository to implement a requested feature.',
    'Make concrete file edits and run relevant checks.',
    '',
    'Feature request:',
    featureRequest,
    '',
    'Approved plan:',
    planText,
    revisionNotes ? '' : '',
    revisionNotes ? 'Additional revision notes:' : '',
    revisionNotes || '',
    '',
    'Return JSON only with this shape:',
    '{"status":"done|failed","summary":"...","checks":"..."}',
  ]
    .filter(Boolean)
    .join('\n')

type GitSummary = {
  ok: boolean
  branch: string
  statusShort: string
  diffStat: string
  summary: string
  error: string
}

const summarizeGit = (repoDir: string): GitSummary => {
  const branch = runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoDir,
  })
  const status = runCommand('git', ['status', '--short'], {cwd: repoDir})
  const diff = runCommand('git', ['diff', '--stat'], {cwd: repoDir})

  if (!status.ok) {
    return {
      ok: false,
      branch: '',
      statusShort: '',
      diffStat: '',
      summary: '',
      error: status.stderr || status.stdout || 'git status failed',
    }
  }

  const branchName = branch.ok ? branch.stdout || '(unknown)' : '(unknown)'
  const statusShort = status.stdout || '(no changes)'
  const diffStat = diff.ok ? diff.stdout || '(none)' : '(unavailable)'

  return {
    ok: true,
    branch: branchName,
    statusShort,
    diffStat,
    summary: [
      `Repo path: ${repoDir}`,
      `Branch: ${branchName}`,
      '',
      'git status --short',
      statusShort,
      '',
      'git diff --stat',
      diffStat,
    ].join('\n'),
    error: '',
  }
}

const repoCollected = ({ctx}: {ctx: Record<string, unknown>}) =>
  asText(ctx.repo_url).length > 0

const featureCollected = ({ctx}: {ctx: Record<string, unknown>}) =>
  asText(ctx.feature_request).length > 0

const planApproved = ({ctx}: {ctx: Record<string, unknown>}) =>
  ctx.plan_approved === true && asText(ctx.plan_text).length > 0

const reviewApproved = ({ctx}: {ctx: Record<string, unknown>}) =>
  ctx.review_approved === true

const collectRepo = async ({ctx}: {ctx: Record<string, unknown>}) => {
  if (asText(ctx.repo_url)) {
    return {status: 'done', data: {human_feedback: null}}
  }

  const reply = asText(ctx.human_feedback)
  if (!reply) {
    return {
      status: 'feedback',
      message: [
        'Share the git repository to clone.',
        '',
        'Accepted formats:',
        '- https://github.com/org/repo',
        '- git@github.com:org/repo.git',
        '- org/repo',
      ].join('\n'),
    }
  }

  const repoUrl = normalizeRepoUrl(reply)
  if (!repoUrl) {
    return {
      status: 'feedback',
      message:
        'I could not parse that repository. Please send a valid git URL or owner/repo.',
      data: {human_feedback: null},
    }
  }

  return {
    status: 'done',
    data: {
      repo_url: repoUrl,
      repo_name: repoNameFromUrl(repoUrl),
      human_feedback: null,
    },
  }
}

const cloneRepo = async ({ctx}: {ctx: Record<string, unknown>}) => {
  const repoUrl = asText(ctx.repo_url)
  if (!repoUrl) {
    return {
      status: 'feedback',
      message: 'I need a repository URL before cloning. Please send one now.',
    }
  }

  const taskId = toSafeSegment(asText(ctx.task_id) || 'task')
  const repoName = toSafeSegment(
    asText(ctx.repo_name) || repoNameFromUrl(repoUrl),
  )
  const repoDir = path.join(WORKSPACE_ROOT, taskId, repoName)
  const gitDir = path.join(repoDir, '.git')

  await mkdir(path.dirname(repoDir), {recursive: true})

  if (await pathExists(gitDir)) {
    return {
      status: 'done',
      data: {repo_dir: repoDir},
    }
  }

  if (await pathExists(repoDir)) {
    return {
      status: 'feedback',
      message: [
        'I found an existing folder for this task that is not a git repo:',
        repoDir,
        '',
        'Please provide a different repository URL.',
      ].join('\n'),
      data: {
        repo_url: '',
        repo_name: '',
        repo_dir: '',
        human_feedback: null,
      },
    }
  }

  const clone = runCommand('git', ['clone', repoUrl, repoDir], {
    timeoutMs: PLAN_TIMEOUT_MS,
  })

  if (!clone.ok) {
    return {
      status: 'feedback',
      message: clipText(
        [
          `Clone failed for: ${repoUrl}`,
          clone.stderr || clone.stdout || `exit code ${clone.code}`,
          '',
          'Please provide a different repository URL.',
        ].join('\n'),
      ),
      data: {
        repo_url: '',
        repo_name: '',
        repo_dir: '',
        human_feedback: null,
      },
    }
  }

  return {
    status: 'done',
    data: {
      repo_dir: repoDir,
      human_feedback: null,
    },
  }
}

const collectFeature = async ({ctx}: {ctx: Record<string, unknown>}) => {
  if (asText(ctx.feature_request)) {
    return {status: 'done', data: {human_feedback: null}}
  }

  const reply = asText(ctx.human_feedback)
  if (!reply) {
    return {
      status: 'feedback',
      message: [
        'Repository cloned.',
        asText(ctx.repo_dir) ? `Local path: ${asText(ctx.repo_dir)}` : '',
        '',
        'What feature should I implement?',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }

  if (reply.length < 8) {
    return {
      status: 'feedback',
      message: 'Please add a bit more detail so I can draft a reliable plan.',
      data: {human_feedback: null},
    }
  }

  return {
    status: 'done',
    data: {
      feature_request: reply,
      plan_text: '',
      plan_approved: false,
      plan_round: 0,
      review_approved: false,
      human_feedback: null,
    },
  }
}

const draftPlan = async ({ctx}: {ctx: Record<string, unknown>}) => {
  const repoDir = asText(ctx.repo_dir)
  const featureRequest = asText(ctx.feature_request)
  const currentPlan = asText(ctx.plan_text)
  const reply = asText(ctx.human_feedback)

  if (!repoDir)
    return {status: 'failed', message: 'Missing repo_dir in context'}
  if (!featureRequest)
    return {status: 'failed', message: 'Missing feature_request in context'}

  if (!currentPlan) {
    const generated = runCodexPlan(repoDir, featureRequest, '', '')
    if (!generated.ok) {
      return {
        status: 'failed',
        message: clipText(`Planning with codex failed: ${generated.error}`),
      }
    }

    return {
      status: 'feedback',
      message: clipText(
        [
          'Proposed implementation plan:',
          '',
          generated.plan,
          '',
          'Reply with:',
          '- APPROVE PLAN',
          '- REVISE PLAN: <changes>',
        ].join('\n'),
      ),
      data: {
        plan_text: generated.plan,
        plan_approved: false,
        plan_round: Number(ctx.plan_round ?? 0) + 1,
        human_feedback: null,
      },
    }
  }

  if (!reply) {
    return {
      status: 'feedback',
      message: 'Please reply with APPROVE PLAN or REVISE PLAN: <notes>.',
    }
  }

  const decision = parsePlanDecision(reply)
  if (decision.decision === 'approve') {
    return {
      status: 'done',
      data: {
        plan_approved: true,
        plan_feedback: reply,
        human_feedback: null,
      },
    }
  }

  if (decision.decision === 'clarify') {
    return {
      status: 'feedback',
      message:
        'I could not classify that response. Please reply with APPROVE PLAN or REVISE PLAN: <notes>.',
      data: {human_feedback: null},
    }
  }

  const revised = runCodexPlan(
    repoDir,
    featureRequest,
    currentPlan,
    decision.notes,
  )
  if (!revised.ok) {
    return {
      status: 'failed',
      message: clipText(`Replanning with codex failed: ${revised.error}`),
    }
  }

  return {
    status: 'feedback',
    message: clipText(
      [
        'Updated implementation plan:',
        '',
        revised.plan,
        '',
        'Reply with:',
        '- APPROVE PLAN',
        '- REVISE PLAN: <changes>',
      ].join('\n'),
    ),
    data: {
      plan_text: revised.plan,
      plan_approved: false,
      plan_feedback: reply,
      plan_revision_notes: decision.notes,
      plan_round: Number(ctx.plan_round ?? 0) + 1,
      human_feedback: null,
    },
  }
}

const implementWithClaude = async ({ctx}: {ctx: Record<string, unknown>}) => {
  const repoDir = asText(ctx.repo_dir)
  const featureRequest = asText(ctx.feature_request)
  const planText = asText(ctx.plan_text)

  if (!repoDir)
    return {status: 'failed', message: 'Missing repo_dir in context'}
  if (!featureRequest)
    return {status: 'failed', message: 'Missing feature_request in context'}
  if (!planText)
    return {status: 'failed', message: 'Missing plan_text in context'}

  const prompt = buildClaudePrompt(featureRequest, planText, '')
  const run = runClaude(repoDir, prompt)
  if (!run.ok) {
    return {
      status: 'failed',
      message: clipText(`Implementation with claude failed: ${run.error}`),
    }
  }

  return {
    status: 'done',
    data: {
      implementation_summary: run.summary,
      implementation_checks: run.checks,
      review_approved: false,
      review_feedback: '',
      human_feedback: null,
    },
  }
}

const reviewChanges = async ({ctx}: {ctx: Record<string, unknown>}) => {
  const repoDir = asText(ctx.repo_dir)
  const featureRequest = asText(ctx.feature_request)
  const planText = asText(ctx.plan_text)
  const reply = asText(ctx.human_feedback)

  if (!repoDir)
    return {status: 'failed', message: 'Missing repo_dir in context'}

  if (!reply) {
    const summary = summarizeGit(repoDir)
    if (!summary.ok) {
      return {
        status: 'failed',
        message: clipText(`Unable to summarize changes: ${summary.error}`),
      }
    }

    return {
      status: 'feedback',
      message: clipText(
        [
          'Implementation update ready for review.',
          '',
          asText(ctx.implementation_summary)
            ? `Implementation summary: ${asText(ctx.implementation_summary)}`
            : '',
          asText(ctx.implementation_checks)
            ? `Checks: ${asText(ctx.implementation_checks)}`
            : '',
          '',
          summary.summary,
          '',
          'Reply with:',
          '- APPROVE CHANGES',
          '- REVISE CHANGES: <updates>',
        ]
          .filter(Boolean)
          .join('\n'),
      ),
      data: {
        repo_branch: summary.branch,
        git_status_short: summary.statusShort,
        git_diff_stat: summary.diffStat,
        change_summary: summary.summary,
        human_feedback: null,
      },
    }
  }

  const decision = parseReviewDecision(reply)
  if (decision.decision === 'approve') {
    return {
      status: 'done',
      data: {
        review_approved: true,
        review_feedback: reply,
        human_feedback: null,
      },
    }
  }

  if (decision.decision === 'clarify') {
    return {
      status: 'feedback',
      message:
        'I could not classify that response. Please reply with APPROVE CHANGES or REVISE CHANGES: <notes>.',
      data: {human_feedback: null},
    }
  }

  if (!featureRequest || !planText) {
    return {
      status: 'failed',
      message: 'Missing feature_request or plan_text for revision step',
    }
  }

  const revisionPrompt = buildClaudePrompt(
    featureRequest,
    planText,
    decision.notes,
  )
  const revision = runClaude(repoDir, revisionPrompt)
  if (!revision.ok) {
    return {
      status: 'failed',
      message: clipText(`Revision with claude failed: ${revision.error}`),
    }
  }

  const summary = summarizeGit(repoDir)
  if (!summary.ok) {
    return {
      status: 'failed',
      message: clipText(
        `Unable to summarize revised changes: ${summary.error}`,
      ),
    }
  }

  return {
    status: 'feedback',
    message: clipText(
      [
        'Applied requested revisions.',
        '',
        `Revision summary: ${revision.summary}`,
        revision.checks ? `Checks: ${revision.checks}` : '',
        '',
        summary.summary,
        '',
        'Reply with:',
        '- APPROVE CHANGES',
        '- REVISE CHANGES: <updates>',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    data: {
      implementation_summary: revision.summary,
      implementation_checks: revision.checks,
      review_feedback: reply,
      review_approved: false,
      review_revision_notes: decision.notes,
      repo_branch: summary.branch,
      git_status_short: summary.statusShort,
      git_diff_stat: summary.diffStat,
      change_summary: summary.summary,
      human_feedback: null,
    },
  }
}

const finalizeReport = async ({ctx}: {ctx: Record<string, unknown>}) => {
  const markdown = [
    '# Intent Demo Outcome',
    '',
    '## Repository',
    `- URL: ${asText(ctx.repo_url) || '(unknown)'}`,
    `- Local path: ${asText(ctx.repo_dir) || '(unknown)'}`,
    `- Branch: ${asText(ctx.repo_branch) || '(unknown)'}`,
    '',
    '## Feature Request',
    asText(ctx.feature_request) || '(none)',
    '',
    '## Approved Plan',
    asText(ctx.plan_text) || '(none)',
    '',
    '## Implementation Summary',
    asText(ctx.implementation_summary) || '(none)',
    '',
    '## Working Tree',
    '```',
    asText(ctx.git_status_short) || '(no status)',
    '```',
    '',
    '## Diff Stat',
    '```',
    asText(ctx.git_diff_stat) || '(no diff)',
    '```',
    '',
    '## Review',
    asText(ctx.review_feedback) || 'Approved',
  ].join('\n')

  return {
    status: 'done',
    page: {markdown},
    data: {final_report: markdown},
  }
}

export default {
  id: FACTORY_ID,
  start: 'collect_repo',
  context: {
    repo_url: '',
    repo_name: '',
    repo_dir: '',
    feature_request: '',
    plan_text: '',
    plan_feedback: '',
    plan_revision_notes: '',
    plan_approved: false,
    plan_round: 0,
    implementation_summary: '',
    implementation_checks: '',
    repo_branch: '',
    git_status_short: '',
    git_diff_stat: '',
    change_summary: '',
    review_feedback: '',
    review_revision_notes: '',
    review_approved: false,
  },
  guards: {
    repoCollected,
    featureCollected,
    planApproved,
    reviewApproved,
  },
  states: {
    collect_repo: {
      type: 'action',
      agent: collectRepo,
      on: {
        done: 'clone_repo',
        feedback: 'wait_repo',
        failed: 'failed',
      },
    },
    wait_repo: {
      type: 'feedback',
      resume: 'collect_repo',
    },
    clone_repo: {
      type: 'action',
      agent: cloneRepo,
      on: {
        done: 'collect_feature',
        feedback: 'wait_repo',
        failed: 'failed',
      },
    },

    collect_feature: {
      type: 'action',
      agent: collectFeature,
      on: {
        done: 'plan_loop',
        feedback: 'wait_feature',
        failed: 'failed',
      },
    },
    wait_feature: {
      type: 'feedback',
      resume: 'collect_feature',
    },

    plan_loop: {
      type: 'loop',
      body: 'draft_plan',
      maxIterations: 5,
      until: 'planApproved',
      on: {
        continue: 'draft_plan',
        done: 'implement_with_claude',
        exhausted: 'blocked',
      },
    },
    draft_plan: {
      type: 'action',
      agent: draftPlan,
      retries: {
        max: 1,
        backoff: {strategy: 'fixed', ms: 1000},
      },
      on: {
        done: 'plan_loop',
        feedback: 'wait_plan_feedback',
        failed: 'failed',
      },
    },
    wait_plan_feedback: {
      type: 'feedback',
      resume: 'draft_plan',
    },

    implement_with_claude: {
      type: 'action',
      agent: implementWithClaude,
      retries: {
        max: 1,
        backoff: {strategy: 'exponential', ms: 1000, maxMs: 8000},
      },
      on: {
        done: 'review_loop',
        failed: 'failed',
      },
    },

    review_loop: {
      type: 'loop',
      body: 'review_changes',
      maxIterations: 5,
      until: 'reviewApproved',
      on: {
        continue: 'review_changes',
        done: 'finalize_report',
        exhausted: 'blocked',
      },
    },
    review_changes: {
      type: 'action',
      agent: reviewChanges,
      on: {
        done: 'review_loop',
        feedback: 'wait_review_feedback',
        failed: 'failed',
      },
    },
    wait_review_feedback: {
      type: 'feedback',
      resume: 'review_changes',
    },

    finalize_report: {
      type: 'action',
      agent: finalizeReport,
      on: {
        done: 'done',
        failed: 'failed',
      },
    },

    done: {type: 'done'},
    blocked: {type: 'blocked'},
    failed: {type: 'failed'},
  },
}
