// VibeCity.Render.Materials: every catalog material the city draws is an Unreal material.
//
// The shared material catalog (shared/assets/materials/catalog.json, read through the core:
// vl_catalog) gives each opaque material a texture-array layer. The HD import
// (scripts/unreal/import-city-materials.sh --hd) bakes the 2K sources of every layer into
// T_CityAlbedoHDArray, T_CityNormalHDArray and T_CityARMHDArray (Poly Haven sets, and real sets for
// the web's procedural limestone, slate and timber). This checks, per catalog material: its layer
// is in all three arrays, and each layer was imported from a 2K source (T_City*HD_NN, 2048 wide);
// and that the city's standing cells are drawn in a material that samples those three arrays.
// Glass is the catalog's one layerless material (VibeCity.Render.Glass).

#include "Engine/Engine.h"
#include "Engine/Texture2D.h"
#include "Engine/Texture2DArray.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Materials/MaterialInterface.h"
#include "Misc/AutomationTest.h"
#include "Components/StaticMeshComponent.h"
#include "ProceduralMeshComponent.h"
#include "Tests/AutomationCommon.h"
#include "VibeCityDirector.h"
#include "vibe_client_core.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
	UWorld* MaterialsTestWorld()
	{
		if (!GEngine)
		{
			return nullptr;
		}
		for (const FWorldContext& Context : GEngine->GetWorldContexts())
		{
			if ((Context.WorldType == EWorldType::Game || Context.WorldType == EWorldType::PIE) && Context.World())
			{
				return Context.World();
			}
		}
		return nullptr;
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityRenderMaterials, "VibeCity.Render.Materials",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityRenderMaterials::RunTest(const FString& Parameters)
{
	const VlMaterial* Catalog = nullptr;
	size_t Count = 0;
	if (!TestEqual(TEXT("the core's catalog loads"), vl_catalog(&Catalog, &Count), 0) || Count == 0)
	{
		return false;
	}
	const TCHAR* Kinds[] = {TEXT("Albedo"), TEXT("Normal"), TEXT("ARM")};
	const TCHAR* LayerKinds[] = {TEXT("Albedo"), TEXT("Normal"), TEXT("Arm")};
	UTexture2DArray* Arrays[3];
	for (int32 K = 0; K < 3; ++K)
	{
		const FString Path = FString::Printf(TEXT("/Game/VibeCity/Textures/T_City%sHDArray.T_City%sHDArray"), Kinds[K], Kinds[K]);
		Arrays[K] = LoadObject<UTexture2DArray>(nullptr, *Path);
		TestNotNull(*FString::Printf(TEXT("%s is imported"), *Path), Arrays[K]);
	}
	int32 Layered = 0;
	for (size_t i = 0; i < Count; ++i)
	{
		const FString Id = UTF8_TO_TCHAR(vl_catalog_id(static_cast<uint32>(i)));
		const int32 Layer = Catalog[i].layer;
		if (Layer < 0)
		{
			AddInfo(FString::Printf(TEXT("%s: no layer (glass: VibeCity.Render.Glass)"), *Id));
			continue;
		}
		++Layered;
		FString Sizes;
		for (int32 K = 0; K < 3; ++K)
		{
			if (Arrays[K])
			{
				TestTrue(*FString::Printf(TEXT("%s: layer %d is in the %s array (%d slices)"), *Id, Layer, Kinds[K], Arrays[K]->GetArraySize()),
					Layer < Arrays[K]->GetArraySize());
			}
			const FString LayerPath = FString::Printf(TEXT("/Game/VibeCity/Textures/Layers/T_City%sHD_%02d.T_City%sHD_%02d"), LayerKinds[K], Layer, LayerKinds[K], Layer);
			const UTexture2D* Source = LoadObject<UTexture2D>(nullptr, *LayerPath);
			TestNotNull(*FString::Printf(TEXT("%s: %s HD layer %02d imported"), *Id, LayerKinds[K], Layer), Source);
			if (Source)
			{
				const int32 Width = static_cast<int32>(Source->GetImportedSize().X);
				TestTrue(*FString::Printf(TEXT("%s: %s layer from a 2K source (%d wide)"), *Id, LayerKinds[K], Width), Width >= 2048);
				Sizes += FString::Printf(TEXT(" %s %d"), LayerKinds[K], Width);
			}
		}
		AddInfo(FString::Printf(TEXT("%s: layer %d,%s"), *Id, Layer, *Sizes));
	}
	AddInfo(FString::Printf(TEXT("%d catalog materials, %d with texture layers"), static_cast<int32>(Count), Layered));

	// The city as drawn: its standing cells' opaque section samples the three HD arrays.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Arrays0 = TWeakObjectPtr<UTexture2DArray>(Arrays[0]),
		Arrays1 = TWeakObjectPtr<UTexture2DArray>(Arrays[1]), Arrays2 = TWeakObjectPtr<UTexture2DArray>(Arrays[2]), Started = FPlatformTime::Seconds()]()
	{
		UWorld* World = MaterialsTestWorld();
		TActorIterator<AVibeCityDirector> It(World);
		AVibeCityDirector* Director = It ? *It : nullptr;
		if (!Director || !Director->IsCityBuilt())
		{
			if (FPlatformTime::Seconds() - Started > 120.0)
			{
				AddError(TEXT("the city was not built within 120 s"));
				return true;
			}
			return false;
		}
		TArray<UProceduralMeshComponent*> Meshes;
		Director->GetComponents(Meshes);
		UMaterialInterface* Drawn = nullptr;
		for (UProceduralMeshComponent* Mesh : Meshes)
		{
			if (Mesh && Mesh->GetNumSections() > 0 && Mesh->GetProcMeshSection(0)->ProcVertexBuffer.Num() > 0)
			{
				Drawn = Mesh->GetMaterial(0);
				break;
			}
		}
		// An imported city's intact cells are static meshes (VibeCity.Render.ImportedCity).
		TArray<UStaticMeshComponent*> Imported;
		Director->GetComponents(Imported);
		for (UStaticMeshComponent* Mesh : Imported)
		{
			if (!Drawn && Mesh && Mesh->GetStaticMesh())
			{
				Drawn = Mesh->GetMaterial(0);
			}
		}
		if (!TestNotNull(TEXT("a standing cell is drawn"), Drawn))
		{
			return true;
		}
		TArray<UTexture*> Used;
		Drawn->GetUsedTextures(Used);
		AddInfo(FString::Printf(TEXT("cells drawn in %s, sampling %d textures"), *Drawn->GetName(), Used.Num()));
		for (const TWeakObjectPtr<UTexture2DArray>& Array : {Arrays0, Arrays1, Arrays2})
		{
			if (Array.IsValid())
			{
				TestTrue(*FString::Printf(TEXT("the city's material samples %s"), *Array->GetName()), Used.Contains(Array.Get()));
			}
		}
		return true;
	}));
	return true;
}

#endif
