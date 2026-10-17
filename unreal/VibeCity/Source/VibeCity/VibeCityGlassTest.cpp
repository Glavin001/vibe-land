// VibeCity.Render.Glass: chunks of the catalog's glass are drawn, in M_VibeCityGlass.
//
// The director draws each standing cell (and each body) as one procedural mesh: section 0 opaque,
// section 1 glass. This counts the glass sections' vertices and their material. The stock city has
// no glass, so the count is required only with -VibeExpectGlass, on a scene with windows
// (destruction/assets/scenes/house-1story.json, for one). With -VibeShotDir the player is stood
// facing the nearest glass and the frame saved as glass.png.

#include "Components/PrimitiveComponent.h"
#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "GameFramework/Pawn.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/PlayerController.h"
#include "Kismet/GameplayStatics.h"
#include "Materials/MaterialInterface.h"
#include "Misc/AutomationTest.h"
#include "ProceduralMeshComponent.h"
#include "Tests/AutomationCommon.h"
#include "UnrealClient.h"
#include "VibeCityDirector.h"
#include "VibeNetSubsystem.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
	UWorld* GlassTestWorld()
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

	struct FGlassCount
	{
		int64 Vertices = 0;
		int32 Sections = 0;
		int32 InGlassMaterial = 0;
		FBox Nearest = FBox(ForceInit);
	};

	/** The director's glass sections (section 1 of its procedural meshes), nearest first to `From`. */
	FGlassCount CountGlass(const FVector& From)
	{
		FGlassCount Count;
		UWorld* World = GlassTestWorld();
		TActorIterator<AVibeCityDirector> It(World);
		AVibeCityDirector* Director = It ? *It : nullptr;
		if (!Director)
		{
			return Count;
		}
		double Best = TNumericLimits<double>::Max();
		TArray<UProceduralMeshComponent*> Meshes;
		Director->GetComponents(Meshes);
		for (UProceduralMeshComponent* Mesh : Meshes)
		{
			if (!Mesh || !Mesh->IsVisible() || Mesh->GetNumSections() < 2)
			{
				continue;
			}
			const FProcMeshSection* Section = Mesh->GetProcMeshSection(1);
			if (!Section || Section->ProcVertexBuffer.Num() == 0)
			{
				continue;
			}
			++Count.Sections;
			Count.Vertices += Section->ProcVertexBuffer.Num();
			const UMaterialInterface* Material = Mesh->GetMaterial(1);
			Count.InGlassMaterial += Material && Material->GetName().Contains(TEXT("VibeCityGlass")) ? 1 : 0;
			const FBox Box = Section->SectionLocalBox.TransformBy(Mesh->GetComponentTransform());
			const double D = FVector::Dist(Box.GetCenter(), From);
			if (D < Best)
			{
				Best = D;
				Count.Nearest = Box;
			}
		}
		return Count;
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityRenderGlass, "VibeCity.Render.Glass",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityRenderGlass::RunTest(const FString& Parameters)
{
	struct FState
	{
		double Deadline = 0.0;
		FGlassCount Glass;
	};
	TSharedRef<FState> S = MakeShared<FState>();
	const bool bExpect = FParse::Param(FCommandLine::Get(), TEXT("VibeExpectGlass"));

	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, bExpect]()
	{
		if (S->Deadline == 0.0)
		{
			S->Deadline = FPlatformTime::Seconds() + 120.0;
		}
		UWorld* World = GlassTestWorld();
		TActorIterator<AVibeCityDirector> It(World);
		AVibeCityDirector* Director = It ? *It : nullptr;
		if (!Director || !Director->IsCityBuilt())
		{
			if (FPlatformTime::Seconds() > S->Deadline)
			{
				AddError(TEXT("the city was not built within 120 s"));
				return true;
			}
			return false;
		}
		APawn* Pawn = UGameplayStatics::GetPlayerPawn(World, 0);
		S->Glass = CountGlass(Pawn ? Pawn->GetActorLocation() : FVector::ZeroVector);
		AddInfo(FString::Printf(TEXT("glass: %lld vertices in %d sections, %d in M_VibeCityGlass"),
			S->Glass.Vertices, S->Glass.Sections, S->Glass.InGlassMaterial));
		TestEqual(TEXT("every glass section wears M_VibeCityGlass"), S->Glass.InGlassMaterial, S->Glass.Sections);
		if (bExpect)
		{
			TestTrue(TEXT("glass is drawn (-VibeExpectGlass)"), S->Glass.Vertices > 0);
		}
		return true;
	}));
	// Stand 6 m from the nearest glass, level with it, and look at it.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S]()
	{
		if (!S->Glass.Nearest.IsValid)
		{
			return true;
		}
		const FVector Centre = S->Glass.Nearest.GetCenter();
		const FVector Eye = Centre + FVector(600.0, 0.0, 0.0);
		UWorld* World = GlassTestWorld();
		UGameInstance* Instance = World ? World->GetGameInstance() : nullptr;
		if (UVibeNetSubsystem* Net = Instance ? Instance->GetSubsystem<UVibeNetSubsystem>() : nullptr)
		{
			Net->CameraDrop(Eye - FVector(0.0, 0.0, 160.0), 180.0f, 0.0f);
		}
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(3.0f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S]()
	{
		UWorld* World = GlassTestWorld();
		APlayerController* PC = UGameplayStatics::GetPlayerController(World, 0);
		APawn* Pawn = UGameplayStatics::GetPlayerPawn(World, 0);
		if (PC && Pawn && S->Glass.Nearest.IsValid)
		{
			PC->SetControlRotation((S->Glass.Nearest.GetCenter() - (Pawn->GetActorLocation() + FVector(0.0, 0.0, 160.0))).Rotation());
		}
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(1.0f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([]()
	{
		FString ShotDir;
		if (FParse::Value(FCommandLine::Get(), TEXT("VibeShotDir="), ShotDir))
		{
			FScreenshotRequest::RequestScreenshot(ShotDir / TEXT("glass.png"), false, false);
		}
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(1.0f));
	return true;
}

#endif
