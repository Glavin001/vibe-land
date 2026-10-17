// The client core is a static library, linked into each module that calls it (through
// VibeLandNet's public dependency), and UBT relinks a module only when one of its own objects
// changes. Including the generated stamp (the library's sha256, rewritten by build-core.sh when the
// library changes) recompiles this file, so this module relinks against the current core rather
// than keeping a stale copy beside the others.
#include "vibe_client_core_build.h"

extern const char* VibeLandCityCoreLibSha256();
const char* VibeLandCityCoreLibSha256()
{
	return VL_CORE_LIB_SHA256;
}
