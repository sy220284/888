import process from 'node:process'
import * as pty from 'node-pty'

const command = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); function prompt { [Console]::Write([char]27 + ']133;D;' + [int]$LASTEXITCODE + [char]7); ('dsh' + '> ') }; [Console]::WriteLine(('__DSH_PWSH_STARTUP_' + 'READY__'))"

const variants = [
  { name: 'interactive-immediate', args: ['-NoLogo', '-NoProfile'], waitAfterPromptMs: 0 },
  { name: 'interactive-100ms', args: ['-NoLogo', '-NoProfile'], waitAfterPromptMs: 100 },
  { name: 'interactive-1000ms', args: ['-NoLogo', '-NoProfile'], waitAfterPromptMs: 1000 },
  { name: 'interactive-bracketed', args: ['-NoLogo', '-NoProfile'], waitAfterPromptMs: 100, bracketed: true },
  { name: 'noninteractive-host', args: ['-NoLogo', '-NoProfile', '-NonInteractive'], waitAfterPromptMs: 100 },
  { name: 'noninteractive-command-stdin', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-NoExit', '-Command', '-'], waitAfterPromptMs: 100, sendWithoutPrompt: true },
]

async function run(variant) {
  await new Promise((resolve) => {
    const terminal = pty.spawn('pwsh', variant.args, {
      name: 'xterm-256color',
      cols: 160,
      rows: 40,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
    })
    let output = ''
    let sent = false
    let settled = false
    const send = () => {
      if (sent || settled) return
      sent = true
      const input = variant.bracketed ? `\x1b[200~${command}\x1b[201~\r` : `${command}\r`
      terminal.write(input)
    }
    const finish = (reason) => {
      if (settled) return
      settled = true
      console.log(JSON.stringify({ name: variant.name, reason, output }))
      try { terminal.kill() } catch {}
      resolve()
    }
    terminal.onData((data) => {
      output += data
      if (!sent && /PS [^\r\n>]*> $/.test(output)) setTimeout(send, variant.waitAfterPromptMs)
      if (output.includes('__DSH_PWSH_STARTUP_READY__')) setTimeout(() => finish('ready'), 250)
    })
    terminal.onExit(({ exitCode, signal }) => finish(`exit:${exitCode}:${signal}`))
    if (variant.sendWithoutPrompt) setTimeout(send, variant.waitAfterPromptMs)
    setTimeout(() => finish('timeout'), 12_000)
  })
}

for (const variant of variants) await run(variant)
