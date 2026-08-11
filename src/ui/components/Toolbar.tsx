import { COMMANDS } from '../commands';
import { MAIN_TOOLBAR } from '../aegisubToolbar';

interface ToolbarProps {
  onCommand: (id: string) => void;
  isCommandEnabled: (id: string) => boolean;
  isCommandChecked: (id: string) => boolean;
}

export function Toolbar({ onCommand, isCommandEnabled, isCommandChecked }: ToolbarProps) {
  return (
    <nav className="toolbar" aria-label="Main toolbar">
      {MAIN_TOOLBAR.map((group, groupIndex) => (
        <div className="toolbar-cluster" key={groupIndex}>
          {group.buttons.map(({ command, icon }) => (
            <button
              className={`tool-button${isCommandChecked(command) ? ' pressed' : ''}`}
              key={command}
              onClick={() => onCommand(command)}
              disabled={!isCommandEnabled(command)}
              aria-pressed={isCommandChecked(command)}
              title={COMMANDS[command]?.label ?? command}
              aria-label={COMMANDS[command]?.label ?? command}
            >
              {icon ? (
                <img src={icon} alt="" width={16} height={16} draggable={false} />
              ) : (
                <span className="tool-button-label">{COMMANDS[command]?.label?.[0] ?? command[0]}</span>
              )}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}
