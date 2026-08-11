import { Check, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { COMMANDS, primaryShortcut, type MenuItemDefinition } from '../commands';
import { AEGISUB_MENUS } from '../aegisubMenus';

interface MenuBarProps {
  projectName: string;
  onCommand: (id: string) => void;
  isCommandEnabled: (id: string) => boolean;
  isCommandChecked?: (id: string) => boolean;
}

export function MenuBar({ projectName, onCommand, isCommandEnabled, isCommandChecked }: MenuBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpenMenu(null);
        setOpenSubmenu(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenu(null);
        setOpenSubmenu(null);
      }
      if (!event.altKey || event.ctrlKey || event.shiftKey) return;
      const menu = AEGISUB_MENUS.find((item) => item.accessKey === event.key.toLowerCase());
      if (menu) {
        event.preventDefault();
        setOpenMenu((current) => (current === menu.id ? null : menu.id));
        setOpenSubmenu(null);
      }
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const closeAll = () => {
    setOpenMenu(null);
    setOpenSubmenu(null);
  };

  const renderItem = (item: MenuItemDefinition, key: string) => {
    if (item.separator) return <div className="menu-separator" role="separator" key={key} />;

    if (item.submenu) {
      const isOpen = openSubmenu === item.submenu.id;
      return (
        <div
          className={`menu-item menu-submenu${isOpen ? ' open' : ''}`}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={isOpen}
          key={key}
          onPointerEnter={() => setOpenSubmenu(item.submenu!.id)}
        >
          <span className="menu-check" />
          <span className="menu-label">{item.submenu.label}</span>
          <span />
          <ChevronRight size={13} />
          {isOpen && (
            <div className="menu-popup menu-popup-sub" role="menu" aria-label={item.submenu.label}>
              {item.submenu.items.map((sub, index) =>
                renderItem(sub, sub.command ?? sub.submenu?.id ?? `sub-${index}`),
              )}
            </div>
          )}
        </div>
      );
    }

    if (!item.command)
      return (
        <button className="menu-item" role="menuitem" disabled key={key}>
          <span className="menu-check" />
          <span className="menu-label">{item.label}</span>
        </button>
      );

    const enabled = !item.disabled && isCommandEnabled(item.command);
    const checked = isCommandChecked?.(item.command) ?? false;
    return (
      <button
        className="menu-item"
        role="menuitem"
        disabled={!enabled}
        key={key}
        onClick={() => {
          closeAll();
          onCommand(item.command!);
        }}
      >
        <span className="menu-check">{checked ? <Check size={13} /> : null}</span>
        <span className="menu-label">{item.label ?? COMMANDS[item.command]?.label ?? item.command}</span>
        <span className="menu-shortcut">{primaryShortcut(item.command)}</span>
        <span />
      </button>
    );
  };

  return (
    <nav className="menu-bar" aria-label="Application menu" ref={rootRef}>
      <div className="menu-list" role="menubar">
        {AEGISUB_MENUS.map((menu) => (
          <div className="menu-root" key={menu.id}>
            <button
              className={`menu-trigger${openMenu === menu.id ? ' open' : ''}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={openMenu === menu.id}
              onClick={() => {
                setOpenMenu((current) => (current === menu.id ? null : menu.id));
                setOpenSubmenu(null);
              }}
              onPointerEnter={() => {
                if (openMenu) {
                  setOpenMenu(menu.id);
                  setOpenSubmenu(null);
                }
              }}
            >
              {menu.label}
            </button>
            {openMenu === menu.id && (
              <div className="menu-popup" role="menu" aria-label={menu.label}>
                {menu.items.map((item, index) => renderItem(item, item.command ?? item.submenu?.id ?? `item-${index}`))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="menu-project" title={projectName}>
        {projectName} - Aegisub Web
      </div>
    </nav>
  );
}
