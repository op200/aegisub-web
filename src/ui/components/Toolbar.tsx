import { MAIN_TOOLBAR } from '../aegisubToolbar'
import { commandTooltip } from '../commands'
import { tPlain } from '../i18n'

interface ToolbarProps {
  onCommand: (id: string) => void
  isCommandEnabled: (id: string) => boolean
  isCommandChecked: (id: string) => boolean
}

export function Toolbar({ onCommand, isCommandEnabled, isCommandChecked }: ToolbarProps) {
  return (
    <nav className="toolbar" aria-label={tPlain('Main toolbar')}>
      {MAIN_TOOLBAR.map((group, groupIndex) => (
        <div className="toolbar-cluster" key={groupIndex}>
          {group.buttons.map(({ command, icon }) => (
            <button
              className={`tool-button${isCommandChecked(command) ? ' pressed' : ''}`}
              key={command}
              onClick={() => onCommand(command)}
              disabled={!isCommandEnabled(command)}
              aria-pressed={isCommandChecked(command)}
              title={commandTooltip(command, 'Default')}
              aria-label={commandTooltip(command, 'Default')}
            >
              {icon ? (
                <img src={icon} alt="" width={16} height={16} draggable={false} />
              ) : (
                <span className="tool-button-label">{command[0]}</span>
              )}
            </button>
          ))}
        </div>
      ))}
    </nav>
  )
}
