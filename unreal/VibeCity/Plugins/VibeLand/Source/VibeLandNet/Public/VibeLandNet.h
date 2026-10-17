#pragma once

#include "CoreMinimal.h"
#include "Logging/LogMacros.h"
#include "Modules/ModuleInterface.h"

VIBELANDNET_API DECLARE_LOG_CATEGORY_EXTERN(LogVibeLand, Log, All);

class VIBELANDNET_API FVibeLandNetModule : public IModuleInterface
{
public:
	virtual void StartupModule() override;
	virtual void ShutdownModule() override;

	/** True when the linked Rust client core matches the header this module was compiled against. */
	static bool IsCoreCompatible();

	/** The linked client core's build description (version, git commit, target, profile). */
	static FString CoreBuildInfo();
};
