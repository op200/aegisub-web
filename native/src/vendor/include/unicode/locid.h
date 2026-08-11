// Minimal ICU Locale shim.

#pragma once

#include <string>

namespace icu {

class Locale {
public:
	static const Locale& getDefault() {
		static Locale def;
		return def;
	}
	const std::string& getName() const {
		static std::string name = "en";
		return name;
	}
};

} // namespace icu
