/**
 * Lua 5.5 → JavaScript 桥接层（Automation 的 WASM 后端）。
 *
 * Lua 本体使用官方 lua/lua v5.5.1 源码（native/third_party/lua-5.5.1），
 * 本文件只负责把 Lua C API 暴露给 JS，并解决两个 wasm 边界问题：
 *
 *   1. lua_State* 不能直接传给 JS，统一映射为整数 handle（>= 1，0 表示无效）。
 *   2. wasm 函数指针无法指向 JS 函数，因此所有 JS 侧 lua_CFunction 都编译成
 *      同一个固定 C 函数 lua_web_dispatch，真实 JS 函数 id 存在 upvalue #1。
 *
 * JS ↔ C 的调用协议（lua_web_js_invoke 返回值）：
 *   >= 0  正常，值为压栈的结果个数
 *   -1    出错（错误值已由 JS 压栈，调用 lua_error）
 *   -2    文本错误（JS 通过 lua_web_set_error 写入，调用 luaL_error 补 file:line 前缀）
 *   -3-n  yield n 个值（等价于 lua_yield(L, n)）
 *
 * 引用（userdata / light userdata / 错误对象）也 handle 化：C 侧在 full
 * userdata 里写 { magic, id, kind }，JS 侧用 Map<id, object> 保存真实对象。
 * 每个 userdata 的元表都注入 C 侧 __gc，回收时回调 JS 释放 Map 条目。
 */
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include <emscripten.h>

// Lua 头文件不自带 extern "C"，C++ 编译时必须手动包一层
extern "C" {
#include "lauxlib.h"
#include "lua.h"
#include "lualib.h"
}

/** EM_JS 必须在文件作用域（不能放进匿名 namespace） */
EM_JS(void, lua_web_js_release, (int id), { Module.luaWeb.release(id); });

EM_JS(int, lua_web_js_invoke, (int id, int handle), {
  try {
    return Module.luaWeb.invoke(id, handle);
  } catch (e) {
    if (e && typeof e.luaYield === 'number') return -3 - e.luaYield;
    if (e && e.luaRaise) return -1;
    if (e && typeof e.luaText === 'string') {
      Module.luaWeb.setTextError(e.luaText);
      return -2;
    }
    Module.luaWeb.pushError(handle, e);
    return -1;
  }
});

namespace {

constexpr uint32_t REF_MAGIC = 0x4C554152u;  // "LUAR"
constexpr int32_t REF_USERDATA = 0;
constexpr int32_t REF_LIGHT = 1;

struct RefHeader {
  uint32_t magic;
  int32_t id;
  int32_t kind;
  int32_t pad;
};

struct StateEntry {
  lua_State *L = nullptr;
  /** 所属主线程的 handle（主线程自身为 0，读取时回退到自己） */
  int main = 0;
};

/** 下标即 handle；0 号槽位保留给无效值 */
std::vector<StateEntry> g_states(1);
int g_next_ref = 1;
int g_strlen = 0;
std::string g_error;
/** JS 写入参用的一块内存（名称、源码等），每次调用按需扩容 */
std::vector<char> g_buf_a;
std::vector<char> g_buf_b;
lua_Debug g_debug;

/** registry 里默认元表的 key（地址本身作为 lightuserdata key） */
char g_user_meta_key;
char g_light_meta_key;

lua_State *resolve(int handle) {
  if (handle <= 0 || handle >= static_cast<int>(g_states.size())) return nullptr;
  return g_states[handle].L;
}

/** 分配 handle 并写入 extraspace；优先复用已关闭 state 留下的空槽 */
int alloc_handle(lua_State *L, int main) {
  int h = 1;
  for (; h < static_cast<int>(g_states.size()); ++h) {
    if (g_states[h].L == nullptr) break;
  }
  if (h == static_cast<int>(g_states.size())) g_states.push_back({L, main});
  else g_states[h] = {L, main};
  *static_cast<int *>(lua_getextraspace(L)) = h;
  return h;
}

/** 当前线程的 handle；脚本自建协程的 extraspace 未初始化，需校验后分配 */
int handle_for(lua_State *L) {
  int h = *static_cast<int *>(lua_getextraspace(L));
  if (h > 0 && h < static_cast<int>(g_states.size()) && g_states[h].L == L) return h;

  int main_handle = 0;
  lua_rawgeti(L, LUA_REGISTRYINDEX, LUA_RIDX_MAINTHREAD);
  lua_State *main = lua_tothread(L, -1);
  lua_pop(L, 1);
  if (main) {
    int v = *static_cast<int *>(lua_getextraspace(main));
    if (v > 0 && v < static_cast<int>(g_states.size()) && g_states[v].L == main) main_handle = v;
  }
  return alloc_handle(L, main_handle);
}

/** 主线程 handle（主线程 entry.main 为 0，回退到自身） */
int main_handle_for(lua_State *L) {
  int h = handle_for(L);
  int m = g_states[h].main;
  return m ? m : h;
}

RefHeader *ref_at(lua_State *L, int idx) {
  if (lua_type(L, idx) != LUA_TUSERDATA) return nullptr;
  void *p = lua_touserdata(L, idx);
  if (!p) return nullptr;
  RefHeader *h = static_cast<RefHeader *>(p);
  return h->magic == REF_MAGIC ? h : nullptr;
}

static int lua_web_gc(lua_State *L);

/** 把默认元表（含 __gc）压栈；userdata 与“light userdata”各一份，惰性创建 */
void push_default_meta(lua_State *L, bool light) {
  char *key = light ? &g_light_meta_key : &g_user_meta_key;
  lua_pushlightuserdata(L, key);
  lua_rawget(L, LUA_REGISTRYINDEX);
  if (!lua_istable(L, -1)) {
    lua_pop(L, 1);
    lua_newtable(L);
    lua_pushcfunction(L, lua_web_gc);
    lua_setfield(L, -2, "__gc");
    lua_pushlightuserdata(L, key);
    lua_pushvalue(L, -2);
    lua_rawset(L, LUA_REGISTRYINDEX);
  }
}

void *new_ref_userdata(lua_State *L, int id, int32_t kind, size_t size) {
  void *p = lua_newuserdatauv(L, size + sizeof(RefHeader), 1);
  RefHeader *h = static_cast<RefHeader *>(p);
  h->magic = REF_MAGIC;
  h->id = id;
  h->kind = kind;
  h->pad = 0;
  push_default_meta(L, kind == REF_LIGHT);
  lua_setmetatable(L, -2);
  return p;
}

int lua_web_gc(lua_State *L) {
  RefHeader *h = ref_at(L, 1);
  if (h) lua_web_js_release(h->id);
  return 0;
}

/** 固定调度器：upvalue #1 是 JS 函数 id，其余为 JS 侧声明的 upvalue */
int lua_web_dispatch(lua_State *L) {
  int id = static_cast<int>(lua_tointeger(L, lua_upvalueindex(1)));
  int handle = handle_for(L);
  int rc = lua_web_js_invoke(id, handle);
  if (rc >= 0) return rc;
  if (rc == -1) return lua_error(L);
  if (rc == -2) return luaL_error(L, "%s", g_error.c_str());
  return lua_yield(L, -3 - rc);
}

char *prepare_buffer(std::vector<char> &buf, int size) {
  if (size < 0) size = 0;
  buf.assign(static_cast<size_t>(size) + 1, '\0');
  return buf.data();
}

int buffer_address(const std::vector<char> &buf) {
  return buf.empty() ? 0 : static_cast<int>(reinterpret_cast<intptr_t>(buf.data()));
}

}  // namespace

// ---------------------------------------------------------------------------
// state / 栈
// ---------------------------------------------------------------------------

extern "C" int lua_web_registry_index() { return LUA_REGISTRYINDEX; }

extern "C" int lua_web_newstate() {
  lua_State *L = luaL_newstate();
  if (!L) return 0;
  int h = alloc_handle(L, 0);
  g_states[h].main = 0;
  return h;
}

extern "C" void lua_web_close(int handle) {
  lua_State *L = resolve(handle);
  if (!L) return;
  int closed_main = g_states[handle].main ? g_states[handle].main : handle;
  lua_close(L);
  for (int i = 1; i < static_cast<int>(g_states.size()); ++i) {
    StateEntry &e = g_states[i];
    if (i == closed_main || e.main == closed_main) {
      e.L = nullptr;
      e.main = 0;
    }
  }
}

extern "C" int lua_web_newthread(int handle) {
  lua_State *L = resolve(handle);
  if (!L) return 0;
  lua_State *L1 = lua_newthread(L);
  int main = main_handle_for(L);
  return alloc_handle(L1, main);
}

extern "C" int lua_web_main_handle(int handle) {
  lua_State *L = resolve(handle);
  if (!L) return 0;
  return main_handle_for(L);
}

extern "C" void lua_web_openlibs(int handle) {
  lua_State *L = resolve(handle);
  if (L) luaL_openlibs(L);
}

extern "C" int lua_web_gettop(int handle) {
  lua_State *L = resolve(handle);
  return L ? lua_gettop(L) : 0;
}

extern "C" void lua_web_settop(int handle, int idx) {
  lua_State *L = resolve(handle);
  if (L) lua_settop(L, idx);
}

extern "C" void lua_web_pushvalue(int handle, int idx) {
  lua_State *L = resolve(handle);
  if (L) lua_pushvalue(L, idx);
}

extern "C" void lua_web_pop(int handle, int n) {
  lua_State *L = resolve(handle);
  if (L) lua_settop(L, -n - 1);
}

extern "C" void lua_web_insert(int handle, int idx) {
  lua_State *L = resolve(handle);
  if (L) lua_insert(L, idx);
}

extern "C" void lua_web_remove(int handle, int idx) {
  lua_State *L = resolve(handle);
  if (L) lua_remove(L, idx);
}

extern "C" void lua_web_replace(int handle, int idx) {
  lua_State *L = resolve(handle);
  if (L) lua_replace(L, idx);
}

extern "C" int lua_web_absindex(int handle, int idx) {
  lua_State *L = resolve(handle);
  return L ? lua_absindex(L, idx) : 0;
}

extern "C" void lua_web_xmove(int from, int to, int n) {
  lua_State *Lfrom = resolve(from);
  lua_State *Lto = resolve(to);
  if (Lfrom && Lto) lua_xmove(Lfrom, Lto, n);
}

// ---------------------------------------------------------------------------
// 类型 / 取值
// ---------------------------------------------------------------------------

extern "C" int lua_web_type(int handle, int idx) {
  lua_State *L = resolve(handle);
  if (!L) return LUA_TNONE;
  int t = lua_type(L, idx);
  if (t == LUA_TUSERDATA) {
    RefHeader *h = ref_at(L, idx);
    if (h && h->kind == REF_LIGHT) return LUA_TLIGHTUSERDATA;
  }
  return t;
}

extern "C" int lua_web_typename(int handle, int tp) {
  lua_State *L = resolve(handle);
  if (!L) {
    g_strlen = 0;
    return 0;
  }
  const char *s = lua_typename(L, tp);
  if (!s) {
    g_strlen = 0;
    return 0;
  }
  g_strlen = static_cast<int>(std::strlen(s));
  return static_cast<int>(reinterpret_cast<intptr_t>(s));
}

extern "C" int lua_web_isnil(int handle, int idx) {
  lua_State *L = resolve(handle);
  return L ? lua_isnil(L, idx) : 0;
}

extern "C" int lua_web_isnumber(int handle, int idx) {
  lua_State *L = resolve(handle);
  return L ? lua_isnumber(L, idx) : 0;
}

extern "C" int lua_web_isstring(int handle, int idx) {
  lua_State *L = resolve(handle);
  return L ? lua_isstring(L, idx) : 0;
}

extern "C" int lua_web_istable(int handle, int idx) {
  lua_State *L = resolve(handle);
  return L ? lua_istable(L, idx) : 0;
}

extern "C" int lua_web_isboolean(int handle, int idx) {
  lua_State *L = resolve(handle);
  return L ? lua_isboolean(L, idx) : 0;
}

extern "C" int lua_web_isfunction(int handle, int idx) {
  lua_State *L = resolve(handle);
  return L ? lua_isfunction(L, idx) : 0;
}

extern "C" int lua_web_isuserdata(int handle, int idx) {
  lua_State *L = resolve(handle);
  return L ? lua_isuserdata(L, idx) : 0;
}

extern "C" int lua_web_isyieldable(int handle) {
  lua_State *L = resolve(handle);
  return L ? lua_isyieldable(L) : 0;
}

extern "C" int lua_web_toboolean(int handle, int idx) {
  lua_State *L = resolve(handle);
  return L ? lua_toboolean(L, idx) : 0;
}

extern "C" double lua_web_tonumber(int handle, int idx) {
  lua_State *L = resolve(handle);
  return L ? static_cast<double>(lua_tonumber(L, idx)) : 0.0;
}

extern "C" double lua_web_tointeger(int handle, int idx) {
  lua_State *L = resolve(handle);
  return L ? static_cast<double>(lua_tointeger(L, idx)) : 0.0;
}

extern "C" int lua_web_tolstring(int handle, int idx) {
  lua_State *L = resolve(handle);
  if (!L) {
    g_strlen = 0;
    return 0;
  }
  size_t len = 0;
  const char *s = lua_tolstring(L, idx, &len);
  if (!s) {
    g_strlen = 0;
    return 0;
  }
  g_strlen = static_cast<int>(len);
  return static_cast<int>(reinterpret_cast<intptr_t>(s));
}

extern "C" int lua_web_touserdata(int handle, int idx) {
  lua_State *L = resolve(handle);
  if (!L) return 0;
  RefHeader *h = ref_at(L, idx);
  return h ? h->id : 0;
}

// ---------------------------------------------------------------------------
// 压栈
// ---------------------------------------------------------------------------

extern "C" void lua_web_pushnil(int handle) {
  lua_State *L = resolve(handle);
  if (L) lua_pushnil(L);
}

extern "C" void lua_web_pushboolean(int handle, int value) {
  lua_State *L = resolve(handle);
  if (L) lua_pushboolean(L, value);
}

extern "C" void lua_web_pushnumber(int handle, double value) {
  lua_State *L = resolve(handle);
  if (L) lua_pushnumber(L, static_cast<lua_Number>(value));
}

extern "C" void lua_web_pushinteger(int handle, double value) {
  lua_State *L = resolve(handle);
  if (L) lua_pushinteger(L, static_cast<lua_Integer>(value));
}

extern "C" void lua_web_pushstring(int handle, int ptr, int len) {
  lua_State *L = resolve(handle);
  if (!L) return;
  if (!ptr || len <= 0) {
    lua_pushstring(L, "");
    return;
  }
  lua_pushlstring(L, reinterpret_cast<const char *>(static_cast<intptr_t>(ptr)),
                  static_cast<size_t>(len));
}

extern "C" void lua_web_pushlightuserdata(int handle, int id) {
  lua_State *L = resolve(handle);
  if (L) new_ref_userdata(L, id, REF_LIGHT, 0);
}

extern "C" int lua_web_newuserdata(int handle, int id) {
  lua_State *L = resolve(handle);
  if (!L) return 0;
  new_ref_userdata(L, id, REF_USERDATA, 0);
  return id;
}

extern "C" void lua_web_newtable(int handle) {
  lua_State *L = resolve(handle);
  if (L) lua_newtable(L);
}

// ---------------------------------------------------------------------------
// 表访问 / 元表
// ---------------------------------------------------------------------------

extern "C" void lua_web_getfield(int handle, int idx, int name) {
  lua_State *L = resolve(handle);
  if (L) lua_getfield(L, idx, reinterpret_cast<const char *>(static_cast<intptr_t>(name)));
}

extern "C" void lua_web_setfield(int handle, int idx, int name) {
  lua_State *L = resolve(handle);
  if (L) lua_setfield(L, idx, reinterpret_cast<const char *>(static_cast<intptr_t>(name)));
}

extern "C" void lua_web_getglobal(int handle, int name) {
  lua_State *L = resolve(handle);
  if (L) lua_getglobal(L, reinterpret_cast<const char *>(static_cast<intptr_t>(name)));
}

extern "C" void lua_web_setglobal(int handle, int name) {
  lua_State *L = resolve(handle);
  if (L) lua_setglobal(L, reinterpret_cast<const char *>(static_cast<intptr_t>(name)));
}

extern "C" void lua_web_rawget(int handle, int idx) {
  lua_State *L = resolve(handle);
  if (L) lua_rawget(L, idx);
}

extern "C" void lua_web_rawset(int handle, int idx) {
  lua_State *L = resolve(handle);
  if (L) lua_rawset(L, idx);
}

extern "C" void lua_web_rawgeti(int handle, int idx, double n) {
  lua_State *L = resolve(handle);
  if (L) lua_rawgeti(L, idx, static_cast<lua_Integer>(n));
}

extern "C" void lua_web_rawseti(int handle, int idx, double n) {
  lua_State *L = resolve(handle);
  if (L) lua_rawseti(L, idx, static_cast<lua_Integer>(n));
}

extern "C" int lua_web_rawlen(int handle, int idx) {
  lua_State *L = resolve(handle);
  return L ? static_cast<int>(lua_rawlen(L, idx)) : 0;
}

extern "C" int lua_web_setmetatable(int handle, int idx) {
  lua_State *L = resolve(handle);
  if (!L) return 0;
  if (!lua_istable(L, -1)) return lua_setmetatable(L, idx);

  int obj = lua_absindex(L, idx);
  int mt = lua_gettop(L);
  if (!ref_at(L, obj)) return lua_setmetatable(L, idx);

  // 复制元表并跳过脚本自己的 __gc，替换为 C 侧释放回调。复制而不是原地改，
  // 避免同一个元表被别处复用时产生副作用。
  lua_newtable(L);
  int copy = lua_gettop(L);
  lua_pushnil(L);
  while (lua_next(L, mt)) {
    if (lua_type(L, -2) == LUA_TSTRING) {
      size_t len = 0;
      const char *k = lua_tolstring(L, -2, &len);
      if (len == 4 && std::memcmp(k, "__gc", 4) == 0) {
        lua_pop(L, 1);
        continue;
      }
    }
    lua_pushvalue(L, -2);
    lua_pushvalue(L, -2);
    lua_settable(L, copy);
    lua_pop(L, 1);
  }
  lua_pushcfunction(L, lua_web_gc);
  lua_setfield(L, copy, "__gc");
  lua_setmetatable(L, obj);
  lua_remove(L, mt);
  return 1;
}

extern "C" int lua_web_next(int handle, int idx) {
  lua_State *L = resolve(handle);
  return L ? lua_next(L, idx) : 0;
}

// ---------------------------------------------------------------------------
// 调用 / 协程
// ---------------------------------------------------------------------------

extern "C" void lua_web_pushclosure(int handle, int id, int nup) {
  lua_State *L = resolve(handle);
  if (!L) return;
  // 让函数 id 成为 upvalue #1：先压 id，再把它旋转到 nup 个用户 upvalue 之下
  lua_pushinteger(L, id);
  lua_insert(L, -(nup + 1));
  lua_pushcclosure(L, lua_web_dispatch, nup + 1);
}

extern "C" int lua_web_pcall(int handle, int nargs, int nresults, int errfunc) {
  lua_State *L = resolve(handle);
  return L ? lua_pcall(L, nargs, nresults, errfunc) : LUA_ERRRUN;
}

extern "C" int lua_web_call(int handle, int nargs, int nresults) {
  lua_State *L = resolve(handle);
  // lua_call 的 longjmp 不能跨 JS 边界；用 pcall 返回状态，由 JS 抛 Rust 风格的错误值
  return L ? lua_pcall(L, nargs, nresults, 0) : LUA_ERRRUN;
}

extern "C" int lua_web_resume(int co, int from, int nargs) {
  lua_State *L = resolve(co);
  lua_State *fromL = resolve(from);
  if (!L) return LUA_ERRRUN;
  int nres = 0;
  return lua_resume(L, fromL, nargs, &nres);
}

extern "C" int lua_web_ref(int handle, int t) {
  lua_State *L = resolve(handle);
  return L ? luaL_ref(L, t) : LUA_NOREF;
}

// ---------------------------------------------------------------------------
// 编译 / 文本
// ---------------------------------------------------------------------------

extern "C" int lua_web_loadbuffer(int handle, int src, int len, int name) {
  lua_State *L = resolve(handle);
  if (!L) return LUA_ERRRUN;
  return luaL_loadbufferx(L, reinterpret_cast<const char *>(static_cast<intptr_t>(src)),
                          static_cast<size_t>(len),
                          reinterpret_cast<const char *>(static_cast<intptr_t>(name)), nullptr);
}

extern "C" int lua_web_dostring(int handle, int src, int len, int name) {
  lua_State *L = resolve(handle);
  if (!L) return LUA_ERRRUN;
  int status = luaL_loadbufferx(L, reinterpret_cast<const char *>(static_cast<intptr_t>(src)),
                                static_cast<size_t>(len),
                                reinterpret_cast<const char *>(static_cast<intptr_t>(name)),
                                nullptr);
  if (status != LUA_OK) return status;
  return lua_pcall(L, 0, LUA_MULTRET, 0);
}

extern "C" void lua_web_set_error(int ptr, int len) {
  if (!ptr || len <= 0) {
    g_error.clear();
    return;
  }
  g_error.assign(reinterpret_cast<const char *>(static_cast<intptr_t>(ptr)), static_cast<size_t>(len));
}

extern "C" int lua_web_buffer(int size) {
  prepare_buffer(g_buf_a, size);
  return buffer_address(g_buf_a);
}

extern "C" int lua_web_buffer2(int size) {
  prepare_buffer(g_buf_b, size);
  return buffer_address(g_buf_b);
}

extern "C" int lua_web_strlen_addr() { return static_cast<int>(reinterpret_cast<intptr_t>(&g_strlen)); }

extern "C" int lua_web_next_ref() { return g_next_ref++; }

// ---------------------------------------------------------------------------
// Debug（traceback 用）
// ---------------------------------------------------------------------------

extern "C" int lua_web_getstack(int handle, int level) {
  lua_State *L = resolve(handle);
  return L ? lua_getstack(L, level, &g_debug) : 0;
}

extern "C" int lua_web_getinfo(int handle, int level) {
  lua_State *L = resolve(handle);
  if (!L) return 0;
  if (!lua_getstack(L, level, &g_debug)) return 0;
  return lua_getinfo(L, "Snl", &g_debug);
}

extern "C" int lua_web_dbg_str(int which) {
  const char *s = nullptr;
  switch (which) {
    case 0: s = g_debug.name; break;
    case 1: s = g_debug.namewhat; break;
    case 2: s = g_debug.what; break;
    case 3: s = g_debug.source; break;
    case 4: s = g_debug.short_src; break;
    default: break;
  }
  if (!s) {
    g_strlen = 0;
    return 0;
  }
  g_strlen = static_cast<int>(std::strlen(s));
  return static_cast<int>(reinterpret_cast<intptr_t>(s));
}

extern "C" int lua_web_dbg_int(int which) {
  switch (which) {
    case 0: return g_debug.currentline;
    case 1: return g_debug.linedefined;
    case 2: return g_debug.lastlinedefined;
    case 3: return g_debug.nups;
    case 4: return g_debug.nparams;
    case 5: return g_debug.isvararg;
    case 6: return g_debug.istailcall;
    default: return 0;
  }
}
