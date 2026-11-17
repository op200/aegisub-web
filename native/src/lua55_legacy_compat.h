/**
 * Lua 5.1 时代的 C 模块（LPeg 0.10 / luabins 0.3）面向 Lua 5.5 的兼容垫片。
 *
 * Aegisub 的 libaegisub/lua/modules/lpeg.c 与 subprojects/luabins 使用了一批
 * Lua 5.2+ 已移除的 API：lua_equal / lua_objlen / luaL_checkint / luaL_register
 * 以及 lua_getfenv / lua_setfenv（Lua 5.4 起由 userdata uservalue 取代）。
 * LPeg 0.10 只在 LUA_VERSION_NUM == 502 时自带兼容宏，这里补齐到 5.5。
 *
 * 通过 native/CMakeLists.txt 的 -include 强制包含在编译这两个模块时。
 */
#ifndef AEGISUB_LUA55_LEGACY_COMPAT_H
#define AEGISUB_LUA55_LEGACY_COMPAT_H

#include "lauxlib.h"
#include "lua.h"

#if LUA_VERSION_NUM >= 502
/* Lua 5.4 起 userdata 的 fenv 就是 uservalue #1（lua_newuserdata 也带 1 个槽位）。
 * lua_equal / lua_objlen 已由 luaconf.h 的兼容宏提供。 */
#define lua_getfenv(L, idx) lua_getiuservalue(L, (idx), 1)
#define lua_setfenv(L, idx) lua_setiuservalue(L, (idx), 1)
#define luaL_register(L, n, f) \
  {                            \
    if ((n) == NULL)           \
      luaL_setfuncs(L, f, 0);  \
    else                       \
      luaL_newlib(L, f);       \
  }
#endif

/* Lua 5.2+ 默认不定义 LUA_COMPAT_APIINTCASTS */
#ifndef luaL_checkint
#define luaL_checkint(L, n) ((int)luaL_checkinteger(L, (n)))
#endif
#ifndef luaL_optint
#define luaL_optint(L, n, d) ((int)luaL_optinteger(L, (n), (d)))
#endif

#endif  // AEGISUB_LUA55_LEGACY_COMPAT_H
