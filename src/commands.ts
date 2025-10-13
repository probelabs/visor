export interface Command {
  type: string;
  args?: string[];
}

export interface CommandRegistry {
  [command: string]: string[]; // command -> check IDs that respond to it
}

export function parseComment(body: string, supportedCommands?: string[]): Command | null {
  const trimmed = body.trim();

  if (!trimmed.startsWith('/')) {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  const command = parts[0].substring(1).toLowerCase();
  const args = parts.slice(1);

  // Default built-in commands
  const builtInCommands = ['help', 'status'];
  const allCommands = supportedCommands
    ? [...builtInCommands, ...supportedCommands]
    : builtInCommands;

  if (!allCommands.includes(command)) {
    return null;
  }

  return {
    type: command,
    args: args.length > 0 ? args : undefined,
  };
}

export function getHelpText(customCommands?: CommandRegistry): string {
  let commandList = '';
  let hasCustomCommands = false;

  // Add custom commands from config
  if (customCommands && Object.keys(customCommands).length > 0) {
    hasCustomCommands = true;
    for (const [command, checkIds] of Object.entries(customCommands)) {
      commandList += `- \`/${command}\` - Run checks: ${checkIds.join(', ')}\n`;
    }
  }

  // Add built-in commands
  commandList += `- \`/status\` - Show current PR status and metrics\n`;
  commandList += `- \`/help\` - Show this help message\n`;

  // Add note if no custom commands are configured
  if (!hasCustomCommands) {
    commandList =
      `*No custom review commands configured. Configure checks with the \`command\` property in your .visor.yaml file.*\n\n` +
      commandList;
  }

  return `## Available Commands

${commandList}
Commands are case-insensitive and can be used in PR comments.

---
*Powered by [Visor](https://github.com/probelabs/visor)*`;
}
