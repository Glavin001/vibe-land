#pragma once

#include "CoreMinimal.h"
#include "Commandlets/Commandlet.h"

#include "VibeCityImportCommandlet.generated.h"

/**
 * Bakes a city manifest into Unreal assets: one static mesh per 32 m cell (VibeCityCells), Nanite,
 * with a mesh distance field so Lumen sees it, and its glass as a separate non-Nanite mesh (Nanite
 * draws no translucency). They are saved under VibeCityCells::SceneFolder(<manifest hash>, <HD|Web>),
 * where the director finds them when a session's manifest has that hash.
 *
 *   UnrealEditor-Cmd VibeCity.uproject -run=VibeCityImport -Manifest=<file> [-Web]
 *
 * The manifest is the uncompressed VLCM `<api>/city-manifest/<hash>` serves (scripts/unreal/
 * import-city.sh fetches it). -Web bakes the web textures' UV scale instead of the 2K sources'.
 */
UCLASS()
class UVibeCityImportCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	UVibeCityImportCommandlet();
	virtual int32 Main(const FString& Params) override;
};
