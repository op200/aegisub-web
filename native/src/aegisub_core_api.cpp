// Aegisub Web —— WASM 核心 C ABI 实现
//
// 实现 wasm/aegisub_core_api.h 定义的稳定 C ABI，把 Aegisub 的 wx-free 文档核心
// （AssFile / AssParser / AssDialogue / AssStyle）暴露给 Web Worker。
//
// 设计约定（与 src/core/types.ts 保持一致，保证 Worker 协议不变）：
//   - state_json 返回的结构 == TS 的 CoreState（document/canUndo/canRedo/undoLabel/redoLabel/runtime）
//   - apply_json 接受的命令 == TS 的 CoreCommand[]
//   - 撤销为整文件快照（与 Aegisub AssFile::Commit 的 push 语义一致，也便于 Worker 用）
//
// 隔离验证 C ABI：用 node 直接加载 wasm 产物（-sENVIRONMENT 含 node）调
// _aegisub_document_state_json，可跳过 UI 层快速定位问题在前端还是核心。

#include "../../wasm/aegisub_core_api.h"

// Aegisub 文档模型
#include "ass_file.h"
#include "ass_parser.h"
#include "ass_dialogue.h"
#include "ass_style.h"
#include "ass_attachment.h"
#include "ass_entry.h"
#include "ass_info.h"

#include <libaegisub/ass/time.h>
#include <libaegisub/cajun/elements.h>
#include <libaegisub/cajun/writer.h>
#include <libaegisub/json.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <memory>
#include <regex>
#include <sstream>
#include <string>
#include <vector>

namespace {

// ---------------------------------------------------------------------------
// 文档状态
// ---------------------------------------------------------------------------

struct AegisubDocument {
	std::unique_ptr<AssFile> file;
	std::vector<std::unique_ptr<AssFile>> undo_stack;
	std::vector<std::unique_ptr<AssFile>> redo_stack;
	std::vector<std::string> undo_labels;
	std::vector<std::string> redo_labels;
	int revision = 0;
	std::string format = "ass";
	std::string source_name = "untitled.ass";
	// --- 撤销栈语义对齐 subs_controller.cpp ---
	// 栈结构：栈底为初始状态、栈顶为当前状态（源码 OnCommit 在提交后快照入栈）；
	// Undo 要求栈内 >1 个条目（subs_controller.cpp:undo_stack.size() <= 1 直接返回）。
	bool coalescable = false;      // 相邻提交合并资格（commit_id 邻接 + redo 空 + 保存后失效）
	std::string amend_label;       // 上一次入栈提交的描述（subs_edit_box：desc 相同才允许 amend）
	std::string amend_target;      // 单条 updateCue 的行 id（编辑框切行 OnActiveLineChanged 重置 commit_id）
	int undo_depth = 50;           // Limits/Undo Levels（下限 2 在入栈时钳制）
};

std::string g_last_error;

void set_error(std::string const& msg) { g_last_error = msg; }

bool is_srt_name(std::string const& name) {
	return name.size() >= 4 &&
	       (name.compare(name.size() - 4, 4, ".srt") == 0 || name.compare(name.size() - 4, 4, ".SRT") == 0);
}

// ---------------------------------------------------------------------------
// JSON 工具（cajun：用隐式转换访问，不用 AsXxx()）
// ---------------------------------------------------------------------------

std::string json_str(json::UnknownElement const& el) {
	try { return std::string(static_cast<json::String const&>(el)); } catch (...) {}
	try { return std::to_string(static_cast<json::Integer const&>(el)); } catch (...) {}
	return "";
}

int json_int(json::UnknownElement const& el) {
	try { return static_cast<int>(static_cast<json::Integer const&>(el)); } catch (...) {}
	try { return static_cast<int>(static_cast<json::Double const&>(el)); } catch (...) {}
	try { return static_cast<int>(static_cast<json::Boolean const&>(el)); } catch (...) {}
	return 0;
}

double json_double(json::UnknownElement const& el) {
	try { return static_cast<double>(static_cast<json::Double const&>(el)); } catch (...) {}
	try { return static_cast<double>(static_cast<json::Integer const&>(el)); } catch (...) {}
	return 0;
}

bool json_bool(json::UnknownElement const& el) {
	try { return static_cast<json::Boolean const&>(el); } catch (...) {}
	try { return static_cast<json::Integer const&>(el) != 0; } catch (...) {}
	return false;
}

std::string obj_get(json::UnknownElement const& el, char const* key) {
	try {
		json::Object const& obj = static_cast<json::Object const&>(el);
		auto it = obj.find(key);
		if (it == obj.end()) return "";
		return json_str(it->second);
	} catch (...) { return ""; }
}

int obj_int(json::UnknownElement const& el, char const* key) {
	try {
		json::Object const& obj = static_cast<json::Object const&>(el);
		auto it = obj.find(key);
		if (it == obj.end()) return 0;
		return json_int(it->second);
	} catch (...) { return 0; }
}

// ---------------------------------------------------------------------------
// 基础文档操作
// ---------------------------------------------------------------------------

std::unique_ptr<AssFile> clone_file(AssFile const& src) { return std::make_unique<AssFile>(src); }

void create_default_document(AssFile& file) {
	// 与 AssFile::LoadDefault 等效但避开 OPT_GET（options 依赖）
	file.Info.emplace_back("Title", "Default Aegisub file");
	file.Info.emplace_back("ScriptType", "v4.00+");
	file.Info.emplace_back("WrapStyle", "0");
	file.Info.emplace_back("ScaledBorderAndShadow", "yes");
	file.Info.emplace_back("PlayResX", "1920");
	file.Info.emplace_back("PlayResY", "1080");
	file.Styles.push_back(*new AssStyle);
	// 默认行带演示文本（对齐 TS 侧 defaults.ts createDocument，上游 AssDialogue 默认为空）。
	// Events 是 boost::intrusive::list（auto_unlink hook）：必须堆分配入链，
	// 栈对象函数返回即析构，链表钩子悬空 → Events 遍历为 UB（表现为无行）。
	// 调试特征：悬空后表现为"遍历为空"而非崩溃，别被"列表为什么空了"误导
	auto* line = new AssDialogue;
	line->Text = "Welcome to Aegisub Web";
	file.Events.push_back(*line);
}

// ---------------------------------------------------------------------------
// 文件解析
// ---------------------------------------------------------------------------

std::vector<std::string> split_lines(std::string_view text) {
	std::vector<std::string> lines;
	size_t start = 0;
	while (start < text.size()) {
		size_t end = text.find('\n', start);
		if (end == std::string_view::npos) end = text.size();
		std::string line(text.substr(start, end - start));
		if (!line.empty() && line.back() == '\r') line.pop_back();
		lines.push_back(std::move(line));
		start = end + 1;
	}
	return lines;
}

bool parse_ass(AegisubDocument& doc, std::string_view text) {
	int version = 1;
	if (doc.source_name.size() >= 4 &&
	    (doc.source_name.compare(doc.source_name.size() - 4, 4, ".ssa") == 0 ||
	     doc.source_name.compare(doc.source_name.size() - 4, 4, ".SSA") == 0))
		version = 0;

	AssParser parser(doc.file.get(), version);
	for (auto const& line : split_lines(text)) parser.AddLine(line);
	return true;
}

// 简单 SRT 解析：按空行分块，每块为 序号 / 时间行 / 文本
bool parse_srt(AegisubDocument& doc, std::string_view text) {
	auto lines = split_lines(text);
	auto parse_time = [](std::string const& s) -> int {
		int h = 0, m = 0, sec = 0, ms = 0;
		if (sscanf(s.c_str(), "%d:%d:%d,%d", &h, &m, &sec, &ms) < 3) {
			if (sscanf(s.c_str(), "%d:%d:%d", &h, &m, &sec) < 3) return 0;
		}
		return ((h * 60 + m) * 60 + sec) * 1000 + ms;
	};

	size_t i = 0;
	while (i < lines.size()) {
		while (i < lines.size() && lines[i].empty()) ++i;
		if (i >= lines.size()) break;
		// 序号行（可忽略）
		if (lines[i].find("-->") == std::string::npos) ++i;
		if (i >= lines.size() || lines[i].find("-->") == std::string::npos) break;

		std::string const& time_line = lines[i++];
		auto arrow = time_line.find("-->");
		if (arrow == std::string::npos) break;
		int start_ms = parse_time(time_line.substr(0, arrow));
		int end_ms = parse_time(time_line.substr(arrow + 3));

		std::string text_buf;
		while (i < lines.size() && !lines[i].empty()) {
			if (!text_buf.empty()) text_buf += "\\N";
			text_buf += lines[i++];
		}
		AssDialogue d;
		d.Start = agi::Time(start_ms);
		d.End = agi::Time(end_ms);
		d.Text = boost::flyweight<std::string>(std::move(text_buf));
		doc.file->Events.push_back(*new AssDialogue(d));
	}
	return true;
}

// ---------------------------------------------------------------------------
// JSON 投影（对齐 TS 的 SubtitleStyle / SubtitleCue / SubtitleDocument）
// ---------------------------------------------------------------------------

std::string ass_color_str(agi::Color const& c) {
	// 样式行颜色格式：&HAABBGGRR
	char buf[16];
	snprintf(buf, sizeof(buf), "&H%02X%02X%02X%02X", c.a, c.b, c.g, c.r);
	return buf;
}

json::Object style_to_json(AssStyle const& s) {
	json::Object o;
	o["id"] = s.name;
	o["name"] = s.name;
	o["fontName"] = s.font;
	o["fontSize"] = s.fontsize;
	o["primaryColor"] = ass_color_str(s.primary);
	o["secondaryColor"] = ass_color_str(s.secondary);
	o["outlineColor"] = ass_color_str(s.outline);
	o["backColor"] = ass_color_str(s.shadow);
	o["bold"] = s.bold;
	o["italic"] = s.italic;
	o["underline"] = s.underline;
	o["strikeout"] = s.strikeout;
	o["scaleX"] = s.scalex;
	o["scaleY"] = s.scaley;
	o["spacing"] = s.spacing;
	o["angle"] = s.angle;
	o["borderStyle"] = s.borderstyle;
	o["outline"] = s.outline_w;
	o["shadow"] = s.shadow_w;
	o["alignment"] = s.alignment;
	o["marginL"] = s.Margin[0];
	o["marginR"] = s.Margin[1];
	o["marginV"] = s.Margin[2];
	o["encoding"] = s.encoding;
	json::Object values;
	values["Name"] = s.name;
	values["Fontname"] = s.font;
	values["Fontsize"] = std::to_string(s.fontsize);
	values["PrimaryColour"] = ass_color_str(s.primary);
	values["SecondaryColour"] = ass_color_str(s.secondary);
	values["OutlineColour"] = ass_color_str(s.outline);
	values["BackColour"] = ass_color_str(s.shadow);
	values["Bold"] = s.bold ? "-1" : "0";
	values["Italic"] = s.italic ? "-1" : "0";
	values["Underline"] = s.underline ? "-1" : "0";
	values["StrikeOut"] = s.strikeout ? "-1" : "0";
	values["ScaleX"] = std::to_string(s.scalex);
	values["ScaleY"] = std::to_string(s.scaley);
	values["Spacing"] = std::to_string(s.spacing);
	values["Angle"] = std::to_string(s.angle);
	values["BorderStyle"] = std::to_string(s.borderstyle);
	values["Outline"] = std::to_string(s.outline_w);
	values["Shadow"] = std::to_string(s.shadow_w);
	values["Alignment"] = std::to_string(s.alignment);
	values["MarginL"] = std::to_string(s.Margin[0]);
	values["MarginR"] = std::to_string(s.Margin[1]);
	values["MarginV"] = std::to_string(s.Margin[2]);
	values["Encoding"] = std::to_string(s.encoding);
	o["values"] = std::move(values);
	return o;
}

json::Object cue_to_json(AssDialogue const& d) {
	json::Object o;
	o["id"] = std::to_string(d.Id);
	o["layer"] = d.Layer;
	o["startMs"] = static_cast<double>(static_cast<int>(d.Start));
	o["endMs"] = static_cast<double>(static_cast<int>(d.End));
	o["style"] = d.Style.get();
	o["actor"] = d.Actor.get();
	o["marginL"] = d.Margin[0];
	o["marginR"] = d.Margin[1];
	o["marginV"] = d.Margin[2];
	o["effect"] = d.Effect.get();
	o["text"] = d.Text.get();
	o["comment"] = d.Comment;
	json::Object extra;
	extra["Layer"] = std::to_string(d.Layer);
	extra["Start"] = d.Start.GetAssFormatted();
	extra["End"] = d.End.GetAssFormatted();
	extra["Style"] = d.Style.get();
	extra["Name"] = d.Actor.get();
	extra["MarginL"] = std::to_string(d.Margin[0]);
	extra["MarginR"] = std::to_string(d.Margin[1]);
	extra["MarginV"] = std::to_string(d.Margin[2]);
	extra["Effect"] = d.Effect.get();
	extra["Text"] = d.Text.get();
	o["extra"] = std::move(extra);
	return o;
}

json::Object document_to_json(AegisubDocument const& doc) {
	json::Object script_info;
	for (auto const& info : doc.file->Info)
		script_info[std::string(info.Key())] = std::string(info.Value());

	json::Array styles;
	for (auto const& style : doc.file->Styles) styles.push_back(style_to_json(style));

	json::Array cues;
	for (auto const& cue : doc.file->Events) cues.push_back(cue_to_json(cue));

	json::Object document;
	document["format"] = doc.format;
	document["sourceName"] = doc.source_name;
	document["revision"] = doc.revision;
	document["scriptInfo"] = std::move(script_info);
	document["styles"] = std::move(styles);
	document["cues"] = std::move(cues);
	document["passthroughSections"] = json::Array();

	json::Object state;
	state["document"] = std::move(document);
	// 栈底为初始状态：只有存在可撤销提交（>1 条目）时才可撤销
	state["canUndo"] = doc.undo_stack.size() > 1;
	state["canRedo"] = !doc.redo_stack.empty();
	state["undoLabel"] = doc.undo_labels.empty() ? "" : doc.undo_labels.back();
	state["redoLabel"] = doc.redo_labels.empty() ? "" : doc.redo_labels.back();
	state["runtime"] = "wasm";
	return state;
}

std::string json_to_string(json::UnknownElement const& el) {
	std::ostringstream ss;
	agi::JsonWriter::Write(el, ss);
	return ss.str();
}

// ---------------------------------------------------------------------------
// 命令应用（对齐 TS 的 CoreCommand[]）
// ---------------------------------------------------------------------------

AssDialogue* find_cue(AssFile& file, std::string const& id) {
	for (auto& cue : file.Events)
		if (std::to_string(cue.Id) == id) return &cue;
	return nullptr;
}

AssStyle* find_style(AssFile& file, std::string const& name) {
	for (auto& style : file.Styles)
		if (style.name == name) return &style;
	return nullptr;
}

void apply_update_cue(AegisubDocument& doc, json::UnknownElement const& cmd) {
	std::string id = obj_get(cmd, "id");
	AssDialogue* cue = find_cue(*doc.file, id);
	if (!cue) return;
	try {
		json::Object const& cmd_obj = static_cast<json::Object const&>(cmd);
		auto patch_it = cmd_obj.find("patch");
		if (patch_it == cmd_obj.end()) return;
		json::Object const& p = static_cast<json::Object const&>(patch_it->second);
		for (auto const& [key, value] : p) {
			if (key == "layer") cue->Layer = json_int(value);
			else if (key == "startMs") cue->Start = agi::Time(json_int(value));
			else if (key == "endMs") cue->End = agi::Time(json_int(value));
			else if (key == "style") cue->Style = boost::flyweight<std::string>(json_str(value));
			else if (key == "actor") cue->Actor = boost::flyweight<std::string>(json_str(value));
			else if (key == "marginL") cue->Margin[0] = json_int(value);
			else if (key == "marginR") cue->Margin[1] = json_int(value);
			else if (key == "marginV") cue->Margin[2] = json_int(value);
			else if (key == "effect") cue->Effect = boost::flyweight<std::string>(json_str(value));
			else if (key == "text") cue->Text = boost::flyweight<std::string>(json_str(value));
			else if (key == "comment") cue->Comment = json_bool(value);
		}
	} catch (...) {}
}

void apply_add_cue(AegisubDocument& doc, json::UnknownElement const& cmd) {
	std::string after_id = obj_get(cmd, "afterId");
	std::string before_id = obj_get(cmd, "beforeId");

	AssDialogue base;
	try {
		json::Object const& cmd_obj = static_cast<json::Object const&>(cmd);
		auto cue_it = cmd_obj.find("cue");
		if (cue_it != cmd_obj.end()) {
			json::Object const& c = static_cast<json::Object const&>(cue_it->second);
			auto set = [&](char const* k, auto fn) {
				auto found = c.find(k);
				if (found != c.end()) fn(found->second);
			};
			set("layer", [&](json::UnknownElement const& v) { base.Layer = json_int(v); });
			set("startMs", [&](json::UnknownElement const& v) { base.Start = agi::Time(json_int(v)); });
			set("endMs", [&](json::UnknownElement const& v) { base.End = agi::Time(json_int(v)); });
			set("style", [&](json::UnknownElement const& v) { base.Style = boost::flyweight<std::string>(json_str(v)); });
			set("actor", [&](json::UnknownElement const& v) { base.Actor = boost::flyweight<std::string>(json_str(v)); });
			set("text", [&](json::UnknownElement const& v) { base.Text = boost::flyweight<std::string>(json_str(v)); });
		}
	} catch (...) {}

	auto* entry = new AssDialogue(base);
	if (!before_id.empty()) {
		for (auto it = doc.file->Events.begin(); it != doc.file->Events.end(); ++it)
			if (std::to_string(it->Id) == before_id) {
				doc.file->Events.insert(it, *entry);
				return;
			}
	} else if (!after_id.empty()) {
		for (auto it = doc.file->Events.begin(); it != doc.file->Events.end(); ++it)
			if (std::to_string(it->Id) == after_id) {
				doc.file->Events.insert(std::next(it), *entry);
				return;
			}
	}
	doc.file->Events.push_back(*entry);
}

void apply_delete_cues(AegisubDocument& doc, json::UnknownElement const& cmd) {
	try {
		json::Object const& cmd_obj = static_cast<json::Object const&>(cmd);
		auto ids_it = cmd_obj.find("ids");
		if (ids_it == cmd_obj.end()) return;
		json::Array const& ids = static_cast<json::Array const&>(ids_it->second);
		for (auto const& id_el : ids) {
			std::string id = json_str(id_el);
			for (auto it = doc.file->Events.begin(); it != doc.file->Events.end(); ++it)
				if (std::to_string(it->Id) == id) {
					doc.file->Events.erase_and_dispose(it, [](AssDialogue* e) { delete e; });
					break;
				}
		}
		if (doc.file->Events.empty()) doc.file->Events.push_back(*new AssDialogue);
	} catch (...) {}
}

void apply_duplicate_cues(AegisubDocument& doc, json::UnknownElement const& cmd) {
	try {
		json::Object const& cmd_obj = static_cast<json::Object const&>(cmd);
		auto ids_it = cmd_obj.find("ids");
		if (ids_it == cmd_obj.end()) return;
		json::Array const& ids = static_cast<json::Array const&>(ids_it->second);
		std::vector<AssDialogue*> to_copy;
		for (auto& cue : doc.file->Events)
			for (auto const& id_el : ids)
				if (std::to_string(cue.Id) == json_str(id_el)) {
					to_copy.push_back(&cue);
					break;
				}
		for (AssDialogue* src : to_copy) {
			auto* copy = new AssDialogue(*src);
			doc.file->Events.insert(std::next(doc.file->Events.iterator_to(*src)), *copy);
		}
	} catch (...) {}
}

void apply_move_cues(AegisubDocument& doc, json::UnknownElement const& cmd) {
	// 简化实现：把选中行与相邻未选中行交换（与 TS runtime 语义一致）
	try {
		json::Object const& cmd_obj = static_cast<json::Object const&>(cmd);
		auto ids_it = cmd_obj.find("ids");
		if (ids_it == cmd_obj.end()) return;
		json::Array const& ids = static_cast<json::Array const&>(ids_it->second);
		int direction = obj_int(cmd, "direction");
		auto selected = [&](AssDialogue const& d) {
			for (auto const& id_el : ids)
				if (std::to_string(d.Id) == json_str(id_el)) return true;
			return false;
		};
		if (direction < 0) {
			auto it = std::next(doc.file->Events.begin());
			while (it != doc.file->Events.end()) {
				auto prev = std::prev(it);
				if (selected(*it) && !selected(*prev)) {
					doc.file->Events.splice(prev, doc.file->Events, it);
					it = std::next(prev);
				} else ++it;
			}
		} else {
			auto it = doc.file->Events.begin();
			while (it != doc.file->Events.end()) {
				auto next = std::next(it);
				if (next != doc.file->Events.end() && selected(*it) && !selected(*next)) {
					doc.file->Events.splice(it, doc.file->Events, next);
				} else ++it;
			}
		}
	} catch (...) {}
}

void apply_update_style(AegisubDocument& doc, json::UnknownElement const& cmd) {
	std::string id = obj_get(cmd, "id");
	AssStyle* style = find_style(*doc.file, id);
	if (!style) return;
	try {
		json::Object const& cmd_obj = static_cast<json::Object const&>(cmd);
		auto patch_it = cmd_obj.find("patch");
		if (patch_it == cmd_obj.end()) return;
		json::Object const& p = static_cast<json::Object const&>(patch_it->second);
		for (auto const& [key, value] : p) {
			if (key == "name") {
				std::string old = style->name;
				style->name = json_str(value);
				for (auto& cue : doc.file->Events)
					if (cue.Style.get() == old) cue.Style = boost::flyweight<std::string>(style->name);
			} else if (key == "fontName") style->font = json_str(value);
			else if (key == "fontSize") style->fontsize = json_double(value);
			else if (key == "primaryColor") style->primary = agi::Color(json_str(value));
			else if (key == "secondaryColor") style->secondary = agi::Color(json_str(value));
			else if (key == "outlineColor") style->outline = agi::Color(json_str(value));
			else if (key == "backColor") style->shadow = agi::Color(json_str(value));
			else if (key == "bold") style->bold = json_bool(value);
			else if (key == "italic") style->italic = json_bool(value);
			else if (key == "underline") style->underline = json_bool(value);
			else if (key == "strikeout") style->strikeout = json_bool(value);
			else if (key == "scaleX") style->scalex = json_double(value);
			else if (key == "scaleY") style->scaley = json_double(value);
			else if (key == "spacing") style->spacing = json_double(value);
			else if (key == "angle") style->angle = json_double(value);
			else if (key == "borderStyle") style->borderstyle = json_int(value);
			else if (key == "outline") style->outline_w = json_double(value);
			else if (key == "shadow") style->shadow_w = json_double(value);
			else if (key == "alignment") style->alignment = json_int(value);
			else if (key == "marginL") style->Margin[0] = json_int(value);
			else if (key == "marginR") style->Margin[1] = json_int(value);
			else if (key == "marginV") style->Margin[2] = json_int(value);
			else if (key == "encoding") style->encoding = json_int(value);
		}
		style->UpdateData();
	} catch (...) {}
}

void apply_add_style(AegisubDocument& doc, json::UnknownElement const& cmd) {
	AssStyle* style = new AssStyle;
	try {
		json::Object const& cmd_obj = static_cast<json::Object const&>(cmd);
		auto s_it = cmd_obj.find("style");
		if (s_it != cmd_obj.end()) {
			json::Object const& s = static_cast<json::Object const&>(s_it->second);
			auto name_it = s.find("name");
			if (name_it != s.end()) style->name = json_str(name_it->second);
		}
	} catch (...) {}
	doc.file->Styles.push_back(*style);
}

void apply_delete_style(AegisubDocument& doc, json::UnknownElement const& cmd) {
	std::string id = obj_get(cmd, "id");
	AssStyle* style = find_style(*doc.file, id);
	if (!style) return;
	if (doc.file->Styles.size() <= 1) return;
	std::string fallback;
	for (auto& s : doc.file->Styles)
		if (s.name != id) {
			fallback = s.name;
			break;
		}
	for (auto& cue : doc.file->Events)
		if (cue.Style.get() == id) cue.Style = boost::flyweight<std::string>(fallback);
	doc.file->Styles.erase_and_dispose(doc.file->Styles.iterator_to(*style), [](AssStyle* e) { delete e; });
}

void apply_reorder_styles(AegisubDocument& doc, json::UnknownElement const& cmd) {
	try {
		json::Object const& cmd_obj = static_cast<json::Object const&>(cmd);
		auto ids_it = cmd_obj.find("ids");
		if (ids_it == cmd_obj.end()) return;
		json::Array const& ids = static_cast<json::Array const&>(ids_it->second);
		int position = 0;
		for (auto const& id_el : ids) {
			AssStyle* style = find_style(*doc.file, json_str(id_el));
			if (!style) continue;
			auto target = doc.file->Styles.begin();
			std::advance(target, std::min(position, static_cast<int>(doc.file->Styles.size())));
			doc.file->Styles.splice(target, doc.file->Styles, doc.file->Styles.iterator_to(*style));
			++position;
		}
	} catch (...) {}
}

void apply_update_script_info(AegisubDocument& doc, json::UnknownElement const& cmd) {
	try {
		json::Object const& cmd_obj = static_cast<json::Object const&>(cmd);
		auto patch_it = cmd_obj.find("patch");
		if (patch_it == cmd_obj.end()) return;
		json::Object const& patch = static_cast<json::Object const&>(patch_it->second);
		for (auto const& [key, value] : patch)
			doc.file->SetScriptInfo(key, json_str(value));
	} catch (...) {}
}

void apply_sort_cues(AegisubDocument& doc) {
	// boost::intrusive list 原地排序（避免 clear+重建造成 use-after-free）
	doc.file->Events.sort([](AssDialogue const& a, AssDialogue const& b) {
		int sa = static_cast<int>(a.Start), sb = static_cast<int>(b.Start);
		if (sa != sb) return sa < sb;
		return static_cast<int>(a.End) < static_cast<int>(b.End);
	});
}

void apply_sort_cues_by(AegisubDocument& doc, json::UnknownElement const& cmd) {
	std::string column = obj_get(cmd, "column");
	auto ci = [](std::string const& s) {
		std::string out;
		out.reserve(s.size());
		for (char c : s) out += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
		return out;
	};
	doc.file->Events.sort([&](AssDialogue const& a, AssDialogue const& b) {
		if (column == "end") return static_cast<int>(a.End) < static_cast<int>(b.End);
		if (column == "style") return ci(a.Style.get()) < ci(b.Style.get());
		if (column == "actor") return ci(a.Actor.get()) < ci(b.Actor.get());
		if (column == "effect") return ci(a.Effect.get()) < ci(b.Effect.get());
		if (column == "layer") return a.Layer < b.Layer;
		int sa = static_cast<int>(a.Start), sb = static_cast<int>(b.Start);
		if (sa != sb) return sa < sb;
		return static_cast<int>(a.End) < static_cast<int>(b.End);
	});
}

// Automation 整表重放：以 Lua subtitles 表最终对白重建 Events（与 TS runtime 一致）
void apply_replace_cues(AegisubDocument& doc, json::UnknownElement const& cmd) {
	try {
		json::Object const& cmd_obj = static_cast<json::Object const&>(cmd);
		auto cues_it = cmd_obj.find("cues");
		if (cues_it == cmd_obj.end()) return;
		json::Array const& cues = static_cast<json::Array const&>(cues_it->second);
		while (!doc.file->Events.empty())
			doc.file->Events.erase_and_dispose(doc.file->Events.begin(), [](AssDialogue* e) { delete e; });
		for (auto const& cue_el : cues) {
			json::Object const& c = static_cast<json::Object const&>(cue_el);
			auto sget = [&](char const* k) -> std::string {
				auto it = c.find(k);
				return it == c.end() ? std::string() : json_str(it->second);
			};
			auto iget = [&](char const* k) -> int {
				auto it = c.find(k);
				return it == c.end() ? 0 : json_int(it->second);
			};
			auto* entry = new AssDialogue;
			entry->Layer = iget("layer");
			entry->Start = agi::Time(iget("startMs"));
			entry->End = agi::Time(iget("endMs"));
			std::string style = sget("style");
			if (!style.empty()) entry->Style = boost::flyweight<std::string>(style);
			entry->Actor = boost::flyweight<std::string>(sget("actor"));
			entry->Margin[0] = iget("marginL");
			entry->Margin[1] = iget("marginR");
			entry->Margin[2] = iget("marginV");
			entry->Effect = boost::flyweight<std::string>(sget("effect"));
			entry->Text = boost::flyweight<std::string>(sget("text"));
			auto comment_it = c.find("comment");
			entry->Comment = comment_it == c.end() ? false : json_bool(comment_it->second);
			doc.file->Events.push_back(*entry);
		}
		if (doc.file->Events.empty()) doc.file->Events.push_back(*new AssDialogue);
	} catch (...) {}
}

void apply_commands(AegisubDocument& doc, json::Array const& commands) {
	for (auto const& cmd : commands) {
		std::string type = obj_get(cmd, "type");
		if (type == "updateCue") apply_update_cue(doc, cmd);
		else if (type == "addCue") apply_add_cue(doc, cmd);
		else if (type == "deleteCues") apply_delete_cues(doc, cmd);
		else if (type == "duplicateCues") apply_duplicate_cues(doc, cmd);
		else if (type == "moveCues") apply_move_cues(doc, cmd);
		else if (type == "updateStyle") apply_update_style(doc, cmd);
		else if (type == "addStyle") apply_add_style(doc, cmd);
		else if (type == "deleteStyle") apply_delete_style(doc, cmd);
		else if (type == "reorderStyles") apply_reorder_styles(doc, cmd);
		else if (type == "updateScriptInfo") apply_update_script_info(doc, cmd);
		else if (type == "sortCues") apply_sort_cues(doc);
		else if (type == "sortCuesBy") apply_sort_cues_by(doc, cmd);
		else if (type == "replaceCues") apply_replace_cues(doc, cmd);
	}
}

// ---------------------------------------------------------------------------
// 搜索替换（对齐 Aegisub SearchReplaceEngine 语义的子集）
// ---------------------------------------------------------------------------

struct SearchSettings {
	std::string find;
	std::string replace_with;
	std::string field = "text"; // text | style | actor | effect
	bool match_case = false;
	bool use_regex = false;
	bool exact_match = false;
	bool skip_tags = true;
};

bool json_bool_member(json::UnknownElement const& el, char const* key) {
	try {
		json::Object const& obj = static_cast<json::Object const&>(el);
		auto it = obj.find(key);
		if (it == obj.end()) return false;
		return json_bool(it->second);
	} catch (...) { return false; }
}

SearchSettings parse_search_settings(json::UnknownElement const& el) {
	SearchSettings s;
	s.find = obj_get(el, "find");
	s.replace_with = obj_get(el, "replaceWith");
	s.field = obj_get(el, "field");
	if (s.field.empty()) s.field = "text";
	s.match_case = json_bool_member(el, "matchCase");
	s.use_regex = json_bool_member(el, "useRegex");
	s.exact_match = json_bool_member(el, "exactMatch");
	s.skip_tags = json_bool_member(el, "skipTags");
	return s;
}

std::string lower_ascii(std::string const& s) {
	std::string out(s);
	for (char& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
	return out;
}

std::string line_field(AssDialogue const& d, std::string const& field) {
	if (field == "style") return d.Style.get();
	if (field == "actor") return d.Actor.get();
	if (field == "effect") return d.Effect.get();
	return d.Text.get();
}

void set_line_field(AssDialogue& d, std::string const& field, std::string const& value) {
	if (field == "style") d.Style = boost::flyweight<std::string>(value);
	else if (field == "actor") d.Actor = boost::flyweight<std::string>(value);
	else if (field == "effect") d.Effect = boost::flyweight<std::string>(value);
	else d.Text = boost::flyweight<std::string>(value);
}

// 去 override 块 {…}，并记录 精简索引 → 原始索引 的映射
struct StrippedText {
	std::string text;
	std::vector<size_t> map;
};

StrippedText strip_override_blocks(std::string const& src) {
	StrippedText out;
	out.map.reserve(src.size());
	bool in_block = false;
	for (size_t i = 0; i < src.size(); ++i) {
		if (src[i] == '{') { in_block = true; continue; }
		if (src[i] == '}') { in_block = false; continue; }
		if (!in_block) {
			out.text += src[i];
			out.map.push_back(i);
		}
	}
	return out;
}

struct SearchMatch {
	size_t start;
	size_t end;
};

std::vector<SearchMatch> find_in(std::string const& haystack, SearchSettings const& s, std::regex const& re) {
	std::vector<SearchMatch> matches;
	auto push_all = [&]() {
		auto begin = std::sregex_iterator(haystack.begin(), haystack.end(), re);
		auto end = std::sregex_iterator();
		for (auto it = begin; it != end; ++it)
			matches.push_back({static_cast<size_t>(it->position()), static_cast<size_t>(it->position() + it->length())});
	};
	if (s.use_regex) {
		push_all();
	} else if (s.match_case) {
		size_t pos = 0;
		while ((pos = haystack.find(s.find, pos)) != std::string::npos) {
			matches.push_back({pos, pos + s.find.size()});
			pos += s.find.size();
		}
	} else {
		std::string needle = lower_ascii(s.find);
		std::string hay = lower_ascii(haystack);
		size_t pos = 0;
		while ((pos = hay.find(needle, pos)) != std::string::npos) {
			matches.push_back({pos, pos + needle.size()});
			pos += needle.size();
		}
	}
	if (s.exact_match) {
		for (auto it = matches.begin(); it != matches.end();) {
			if (!(it->start == 0 && it->end == haystack.size())) it = matches.erase(it);
			else ++it;
		}
	}
	return matches;
}

// 搜索单个事件，返回 原文本中的匹配区间（text 字段且 skipTags 时做映射）
std::vector<SearchMatch> search_line(AssDialogue const& d, SearchSettings const& s, std::regex const& re) {
	std::string raw = line_field(d, s.field);
	bool is_text = s.field == "text" || s.field.empty();
	if (is_text && s.skip_tags) {
		StrippedText st = strip_override_blocks(raw);
		auto matches = find_in(st.text, s, re);
		std::vector<SearchMatch> out;
		out.reserve(matches.size());
		for (auto const& m : matches) {
			if (m.end > st.map.size()) continue;
			out.push_back({st.map[m.start], (m.end > 0 ? st.map[m.end - 1] : st.map[m.start]) + 1});
		}
		return out;
	}
	return find_in(raw, s, re);
}

std::string apply_replacements(std::string const& src, std::vector<SearchMatch> const& matches, std::string const& replacement) {
	if (matches.empty()) return src;
	std::string out;
	size_t last = 0;
	for (auto const& m : matches) {
		if (m.start < last) continue;
		out.append(src, last, m.start - last);
		out += replacement;
		last = m.end;
	}
	out.append(src, last, src.size() - last);
	return out;
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

std::string export_ass(AegisubDocument const& doc) {
	std::string out;
	out += "[Script Info]\r\n";
	for (auto const& info : doc.file->Info) out += std::string(info.GetEntryData()) + "\r\n";
	out += "\r\n[V4+ Styles]\r\n";
	out += "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\r\n";
	for (auto const& style : doc.file->Styles) out += style.GetEntryData() + "\r\n";
	out += "\r\n[Events]\r\n";
	out += "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\n";
	for (auto const& cue : doc.file->Events) out += cue.GetEntryData() + "\r\n";
	return out;
}

std::string srt_time(int ms) {
	int total = ms;
	int h = total / 3600000; total %= 3600000;
	int m = total / 60000; total %= 60000;
	int s = total / 1000; total %= 1000;
	char buf[32];
	snprintf(buf, sizeof(buf), "%02d:%02d:%02d,%03d", h, m, s, total);
	return buf;
}

std::string export_srt(AegisubDocument const& doc) {
	std::string out;
	int index = 1;
	for (auto const& cue : doc.file->Events) {
		if (cue.Comment) continue;
		out += std::to_string(index++) + "\r\n";
		out += srt_time(static_cast<int>(cue.Start)) + " --> " + srt_time(static_cast<int>(cue.End)) + "\r\n";
		std::string text = cue.GetStrippedText();
		std::string clean;
		for (size_t i = 0; i < text.size(); ++i) {
			if (text[i] == '\\' && i + 1 < text.size() && (text[i + 1] == 'N' || text[i + 1] == 'n')) {
				clean += "\r\n";
				++i;
			} else clean += text[i];
		}
		out += clean + "\r\n\r\n";
	}
	return out;
}

} // namespace

// ---------------------------------------------------------------------------
// C ABI
// ---------------------------------------------------------------------------

extern "C" {

uint32_t aegisub_core_abi_version(void) { return 2; }

aegisub_document_t aegisub_document_create(void) {
	try {
		auto* doc = new AegisubDocument;
		doc->file = std::make_unique<AssFile>();
		create_default_document(*doc->file);
		return reinterpret_cast<aegisub_document_t>(doc);
	} catch (std::exception const& e) {
		set_error(e.what());
		return 0;
	}
}

void aegisub_document_destroy(aegisub_document_t document) {
	delete reinterpret_cast<AegisubDocument*>(document);
}

int32_t aegisub_document_open(aegisub_document_t document, const uint8_t* data, size_t size, const char* source_name) {
	try {
		auto* doc = reinterpret_cast<AegisubDocument*>(document);
		if (!doc) {
			set_error("null document");
			return -1;
		}
		doc->source_name = source_name ? source_name : "untitled.ass";
		doc->format = is_srt_name(doc->source_name) ? "srt" : "ass";
		std::string text(reinterpret_cast<const char*>(data), size);
		doc->file = std::make_unique<AssFile>();
		if (doc->format == "srt") {
			if (!parse_srt(*doc, text)) {
				set_error("parse failed");
				return -1;
			}
		} else {
			parse_ass(*doc, text);
		}
		if (doc->file->Styles.empty()) doc->file->Styles.push_back(*new AssStyle);
		if (doc->file->Events.empty()) doc->file->Events.push_back(*new AssDialogue);
		doc->undo_stack.clear();
		doc->redo_stack.clear();
		doc->undo_labels.clear();
		doc->redo_labels.clear();
		// 栈底压入初始状态（源码加载路径 Commit("", COMMIT_NEW) 建立首个撤销点）
		doc->undo_stack.push_back(clone_file(*doc->file));
		doc->undo_labels.push_back("");
		doc->coalescable = false;
		doc->amend_label.clear();
		doc->amend_target.clear();
		doc->revision = 0;
		return 0;
	} catch (std::exception const& e) {
		set_error(e.what());
		return -1;
	}
}

const char* aegisub_document_state_json(aegisub_document_t document) {
	try {
		auto* doc = reinterpret_cast<AegisubDocument*>(document);
		if (!doc) {
			set_error("null document");
			return nullptr;
		}
		auto state = document_to_json(*doc);
		// UnknownElement 拷贝构造被删除，必须显式 move 构造
		std::string json = json_to_string(json::UnknownElement(std::move(state)));
		char* buf = static_cast<char*>(malloc(json.size() + 1));
		memcpy(buf, json.c_str(), json.size() + 1);
		return buf;
	} catch (std::exception const& e) {
		set_error(e.what());
		return nullptr;
	}
}

int32_t aegisub_document_apply_json(aegisub_document_t document, const char* commands_json, const char* label) {
	try {
		auto* doc = reinterpret_cast<AegisubDocument*>(document);
		if (!doc) {
			set_error("null document");
			return -1;
		}
		if (!commands_json || !*commands_json) return 0;
		std::istringstream ss(commands_json);
		auto parsed = agi::json_util::parse(ss);
		json::Array const& commands = static_cast<json::Array const&>(parsed);
		if (commands.empty()) return 0;

		std::string label_str = label ? label : "";
		// 空描述提交：数据改变但不建立撤销点（subs_controller.cpp:OnCommit 空消息早退）
		if (label_str.empty() && !doc->undo_stack.empty()) {
			apply_commands(*doc, commands);
			++doc->revision;
			return 0;
		}
		// 相邻提交合并（subs_controller.cpp:OnCommit）：同描述 + 同目标行 + redo 空 + 保存后失效。
		// 源码 single_line 原位更新/弹栈重推两种合并路径对外都表现为"一个撤销点"，此处统一弹栈重推。
		std::string target = commands.size() == 1 ? obj_get(commands.front(), "id") : std::string();
		bool coalesce = doc->coalescable && doc->redo_stack.empty() && !doc->undo_stack.empty() &&
		                label_str == doc->amend_label && target == doc->amend_target;
		if (coalesce) {
			doc->undo_stack.pop_back();
			if (!doc->undo_labels.empty()) doc->undo_labels.pop_back();
		}

		apply_commands(*doc, commands);
		++doc->revision;
		// 提交后快照入栈：栈顶始终是当前状态
		doc->undo_stack.push_back(clone_file(*doc->file));
		doc->undo_labels.push_back(label_str);
		doc->amend_label = label_str;
		doc->amend_target = target;
		doc->coalescable = true;
		int depth = std::max(doc->undo_depth, 2);
		while (static_cast<int>(doc->undo_stack.size()) > depth) {
			doc->undo_stack.erase(doc->undo_stack.begin());
			doc->undo_labels.erase(doc->undo_labels.begin());
		}
		return 0;
	} catch (std::exception const& e) {
		set_error(e.what());
		return -1;
	}
}

int32_t aegisub_document_undo(aegisub_document_t document) {
	auto* doc = reinterpret_cast<AegisubDocument*>(document);
	// 栈底为初始状态，不可撤销过初始点（subs_controller.cpp:undo_stack.size() <= 1 返回）
	if (!doc || doc->undo_stack.size() <= 1) return -1;
	// 栈顶（当前状态）移入 redo 栈，然后应用新的栈顶（上一个状态）
	doc->redo_stack.push_back(std::move(doc->undo_stack.back()));
	doc->undo_stack.pop_back();
	doc->redo_labels.push_back(doc->undo_labels.back());
	doc->undo_labels.pop_back();
	doc->file = clone_file(*doc->undo_stack.back());
	doc->coalescable = false;
	return 0;
}

int32_t aegisub_document_redo(aegisub_document_t document) {
	auto* doc = reinterpret_cast<AegisubDocument*>(document);
	if (!doc || doc->redo_stack.empty()) return -1;
	doc->undo_stack.push_back(std::move(doc->redo_stack.back()));
	doc->redo_stack.pop_back();
	doc->undo_labels.push_back(doc->redo_labels.back());
	doc->redo_labels.pop_back();
	doc->file = clone_file(*doc->undo_stack.back());
	doc->coalescable = false;
	return 0;
}

int32_t aegisub_document_mark_saved(aegisub_document_t document) {
	auto* doc = reinterpret_cast<AegisubDocument*>(document);
	if (!doc) {
		set_error("null document");
		return -1;
	}
	// 保存后下一次提交不再与保存前合并（subs_controller.cpp:saved_commit_id+1 != commit_id）
	doc->coalescable = false;
	return 0;
}

int32_t aegisub_document_configure(aegisub_document_t document, int32_t undo_levels) {
	auto* doc = reinterpret_cast<AegisubDocument*>(document);
	if (!doc) {
		set_error("null document");
		return -1;
	}
	doc->undo_depth = undo_levels;
	return 0;
}

const uint8_t* aegisub_document_export(aegisub_document_t document, const char* format, size_t* size) {
	try {
		auto* doc = reinterpret_cast<AegisubDocument*>(document);
		if (!doc) {
			set_error("null document");
			return nullptr;
		}
		std::string out = (format && std::string_view(format) == "srt") ? export_srt(*doc) : export_ass(*doc);
		uint8_t* buf = static_cast<uint8_t*>(malloc(out.size()));
		memcpy(buf, out.data(), out.size());
		if (size) *size = out.size();
		return buf;
	} catch (std::exception const& e) {
		set_error(e.what());
		return nullptr;
	}
}

const char* aegisub_document_search(aegisub_document_t document, const char* settings_json) {
	try {
		auto* doc = reinterpret_cast<AegisubDocument*>(document);
		if (!doc) { set_error("null document"); return nullptr; }
		if (!settings_json) { set_error("null settings"); return nullptr; }
		std::istringstream ss(settings_json);
		auto parsed = agi::json_util::parse(ss);
		SearchSettings settings = parse_search_settings(parsed);

		std::regex re;
		std::regex::flag_type flags = std::regex::ECMAScript;
		if (!settings.match_case) flags |= std::regex::icase;
		try { re = std::regex(settings.find, flags); }
		catch (std::regex_error const& e) { set_error(e.what()); return nullptr; }

		json::Array matches;
		for (auto const& cue : doc->file->Events) {
			auto found = search_line(cue, settings, re);
			for (auto const& m : found) {
				json::Object entry;
				entry["id"] = std::to_string(cue.Id);
				entry["start"] = static_cast<double>(m.start);
				entry["end"] = static_cast<double>(m.end);
				entry["field"] = settings.field;
				matches.push_back(std::move(entry));
			}
		}
		std::string json = json_to_string(json::UnknownElement(std::move(matches)));
		char* buf = static_cast<char*>(malloc(json.size() + 1));
		memcpy(buf, json.c_str(), json.size() + 1);
		return buf;
	} catch (std::exception const& e) {
		set_error(e.what());
		return nullptr;
	}
}

int32_t aegisub_document_replace_all(aegisub_document_t document, const char* settings_json) {
	try {
		auto* doc = reinterpret_cast<AegisubDocument*>(document);
		if (!doc) { set_error("null document"); return -1; }
		if (!settings_json) { set_error("null settings"); return -1; }
		std::istringstream ss(settings_json);
		auto parsed = agi::json_util::parse(ss);
		SearchSettings settings = parse_search_settings(parsed);

		std::regex re;
		std::regex::flag_type flags = std::regex::ECMAScript;
		if (!settings.match_case) flags |= std::regex::icase;
		try { re = std::regex(settings.find, flags); }
		catch (std::regex_error const& e) { set_error(e.what()); return -1; }

		int replaced = 0;
		for (auto& cue : doc->file->Events) {
			auto matches = search_line(cue, settings, re);
			if (matches.empty()) continue;
			std::string value = apply_replacements(line_field(cue, settings.field), matches, settings.replace_with);
			set_line_field(cue, settings.field, value);
			replaced += static_cast<int>(matches.size());
		}
		if (replaced > 0) {
			// 替换成功才算一次提交（search_replace_engine.cpp:Commit(_("replace"))）
			doc->undo_stack.push_back(clone_file(*doc->file));
			doc->undo_labels.push_back("Replace all");
			doc->amend_label = "Replace all";
			doc->amend_target.clear();
			doc->coalescable = true;
			doc->redo_stack.clear();
			doc->redo_labels.clear();
			++doc->revision;
			int depth = std::max(doc->undo_depth, 2);
			while (static_cast<int>(doc->undo_stack.size()) > depth) {
				doc->undo_stack.erase(doc->undo_stack.begin());
				doc->undo_labels.erase(doc->undo_labels.begin());
			}
		}
		return replaced;
	} catch (std::exception const& e) {
		set_error(e.what());
		return -1;
	}
}

void aegisub_core_free(const void* memory) { free(const_cast<void*>(memory)); }

const char* aegisub_core_last_error(void) { return g_last_error.c_str(); }

} // extern "C"
