#include "VibeLandNet.h"

#include "Modules/ModuleManager.h"
#include "vibe_client_core.h"
#include "vibe_client_core_build.h"

DEFINE_LOG_CATEGORY(LogVibeLand);

void FVibeLandNetModule::StartupModule()
{
	if (IsCoreCompatible())
	{
		UE_LOG(LogVibeLand, Display, TEXT("vibe client core loaded: abi %u, %s, lib sha256 %s"), vl_abi_version(), *CoreBuildInfo(), TEXT(VL_CORE_LIB_SHA256));
	}
	else
	{
		UE_LOG(LogVibeLand, Error,
			TEXT("vibe client core ABI mismatch: library %u, header %u (%s). Rebuild with scripts/unreal/build-core.sh."),
			vl_abi_version(), (uint32)VL_ABI_VERSION, *CoreBuildInfo());
	}
}

void FVibeLandNetModule::ShutdownModule()
{
}

bool FVibeLandNetModule::IsCoreCompatible()
{
	return vl_abi_version() == VL_ABI_VERSION;
}

FString FVibeLandNetModule::CoreBuildInfo()
{
	const char* Info = vl_build_info();
	return Info ? FString(UTF8_TO_TCHAR(Info)) : FString(TEXT("(none)"));
}

IMPLEMENT_MODULE(FVibeLandNetModule, VibeLandNet)
