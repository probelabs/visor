export interface Command {
  type: string;
  args?: string[];
}

export function parseComment(body: string): Command | null {
  const trimmed = body.trim();

  if (!trimmed.startsWith('/')) {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  const command = parts[0].substring(1).toLowerCase();
  const args = parts.slice(1);

  const supportedCommands = ['review', 'help', 'status'];

  if (!supportedCommands.includes(command)) {
    return null;
  }

  return {
    type: command,
    args: args.length > 0 ? args : undefined,
  };
}

export function getHelpText(): string {
  return `## Available Commands

- \`/review\` - Perform a code review of the current PR
- \`/review --focus=security\` - Focus review on security issues  
- \`/review --format=detailed\` - Provide detailed review comments
- \`/status\` - Show current PR status and metrics
- \`/help\` - Show this help message

Commands are case-insensitive and can be used in PR comments.

---
*Powered by [Visor](https://probelabs.com/visor) from [Probelabs](https://probelabs.com)*`;
}
