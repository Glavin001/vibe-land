#include "VibeCityDirector.h"

#include "Components/InstancedStaticMeshComponent.h"
#include "Components/SceneComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/Pawn.h"
#include "GameFramework/PlayerController.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "UnrealClient.h"
#include "UObject/ConstructorHelpers.h"
#include "VibeLandNet.h"
#include "VibeNetSubsystem.h"
#include "vibe_client_core.h"

namespace
{
	FVector ToVector(const float (&V)[3]) { return FVector(V[0], V[1], V[2]); }
	FQuat ToQuat(const float (&Q)[4]) { return FQuat(Q[0], Q[1], Q[2], Q[3]).GetNormalized(); }

	FLinearColor ToColor(uint32 Rgba)
	{
		return FLinearColor(FColor((Rgba >> 24) & 0xFF, (Rgba >> 16) & 0xFF, (Rgba >> 8) & 0xFF, Rgba & 0xFF));
	}

	// A removed chunk is hidden by collapsing its instance (instances keep their indices).
	const FTransform HiddenTransform(FQuat::Identity, FVector::ZeroVector, FVector(KINDA_SMALL_NUMBER));

	// Players: the server's player position is the capsule's centre; draw a 1.8 m column on it.
	const FVector PlayerScale(0.6, 0.6, 1.8);
}

AVibeCityDirector::AVibeCityDirector()
{
	PrimaryActorTick.bCanEverTick = true;
	PrimaryActorTick.TickGroup = TG_PrePhysics;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));

	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cube(TEXT("/Engine/BasicShapes/Cube.Cube"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cylinder(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	static ConstructorHelpers::FObjectFinder<UMaterialInterface> Material(TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	CubeMesh = Cube.Object;
	CylinderMesh = Cylinder.Object;
	BaseMaterial = Material.Object;
}

UVibeNetSubsystem* AVibeCityDirector::Net() const
{
	UGameInstance* GameInstance = GetGameInstance();
	return GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr;
}

int32 AVibeCityDirector::ChunksOnBodies() const
{
	int32 Count = 0;
	for (const TPair<uint64, TArray<int32>>& Pair : BodyChunks)
	{
		Count += Pair.Value.Num();
	}
	return Count;
}

void AVibeCityDirector::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	UVibeNetSubsystem* NetSubsystem = Net();
	const VlFrameView* Frame = NetSubsystem ? NetSubsystem->Poll() : nullptr;
	if (!Frame)
	{
		return;
	}
	if (!bCityBuilt && Frame->stats.chunks > 0)
	{
		BuildCity(NetSubsystem);
	}
	if (bCityBuilt)
	{
		ApplyFrame(*Frame);
	}
	SyncPlayers(*Frame);
	ShowStatus(*Frame);
	LogTransitions(*Frame, DeltaSeconds);
	MaybeScreenshot(DeltaSeconds);
}

void AVibeCityDirector::MaybeScreenshot(float DeltaSeconds)
{
	// -VibeShotDir=<dir> -VibeShotEvery=<seconds>: numbered screenshots for scripted checks (works
	// with -RenderOffscreen, so nothing has to be on screen).
	if (ShotEvery < 0.0f)
	{
		ShotEvery = 0.0f;
		FParse::Value(FCommandLine::Get(), TEXT("VibeShotDir="), ShotDir);
		FParse::Value(FCommandLine::Get(), TEXT("VibeShotEvery="), ShotEvery);
		if (ShotDir.IsEmpty() || ShotEvery <= 0.0f)
		{
			ShotEvery = 0.0f;
		}
	}
	if (ShotEvery <= 0.0f || !bCityBuilt)
	{
		return;
	}
	SecondsSinceShot += DeltaSeconds;
	if (SecondsSinceShot >= ShotEvery)
	{
		SecondsSinceShot = 0.0f;
		const FString Path = FPaths::Combine(ShotDir, FString::Printf(TEXT("vibecity_%03d.png"), ShotCount++));
		FScreenshotRequest::RequestScreenshot(Path, /*bInShowUI=*/true, /*bAddFilenameSuffix=*/false);
		UE_LOG(LogVibeLand, Display, TEXT("screenshot %s"), *Path);
	}
}

void AVibeCityDirector::LogTransitions(const VlFrameView& Frame, float DeltaSeconds)
{
	const VlStats& S = Frame.stats;
	if (Frame.transport_state != LastTransportState || S.state != LastCoreState)
	{
		const UVibeNetSubsystem* NetSubsystem = Net();
		UE_LOG(LogVibeLand, Display, TEXT("transport %u -> %u, core %u -> %u (chunks %u, player %u)%s%s"),
			LastTransportState, Frame.transport_state, LastCoreState, S.state, S.chunks, S.player_id,
			NetSubsystem && !NetSubsystem->LastError().IsEmpty() ? TEXT(": ") : TEXT(""),
			NetSubsystem ? *NetSubsystem->LastError() : TEXT(""));
		LastTransportState = Frame.transport_state;
		LastCoreState = S.state;
	}
	SecondsSinceStatus += DeltaSeconds;
	if (SecondsSinceStatus >= 5.0f)
	{
		SecondsSinceStatus = 0.0f;
		const APlayerController* Controller = GetWorld()->GetFirstPlayerController();
		const APawn* Pawn = Controller ? Controller->GetPawn() : nullptr;
		UE_LOG(LogVibeLand, Display, TEXT("status: chunks %u, bodies %d (%d chunks on them), remote players %u, snapshots %llu, fractures %llu, keyframes %llu, hash %llu/%llu, decode errors %llu; camera %s %s"),
			S.chunks, PosedBodies(), ChunksOnBodies(), S.remote_players, S.snapshots, S.fractures, S.keyframes,
			S.hash_checks, S.hash_mismatches, S.decode_errors,
			Pawn ? *Pawn->GetActorLocation().ToCompactString() : TEXT("-"),
			Controller ? *Controller->GetControlRotation().ToCompactString() : TEXT("-"));
	}
}

void AVibeCityDirector::BuildCity(UVibeNetSubsystem* NetSubsystem)
{
	const TArrayView<const VlChunk> Chunks = NetSubsystem->Chunks();
	if (Chunks.Num() == 0)
	{
		return;
	}
	const double Started = FPlatformTime::Seconds();

	// One instanced mesh per colour, so each can carry its own material colour.
	TMap<uint32, int32> ComponentByColor;
	Slots.SetNum(Chunks.Num());
	TArray<TArray<FTransform>> Instances;
	for (int32 Index = 0; Index < Chunks.Num(); ++Index)
	{
		const VlChunk& Chunk = Chunks[Index];
		int32* Existing = ComponentByColor.Find(Chunk.color_rgba);
		int32 ComponentIndex = Existing ? *Existing : INDEX_NONE;
		if (ComponentIndex == INDEX_NONE)
		{
			UInstancedStaticMeshComponent* Component = NewObject<UInstancedStaticMeshComponent>(this);
			Component->SetStaticMesh(CubeMesh);
			Component->SetMobility(EComponentMobility::Movable);
			Component->SetCollisionEnabled(ECollisionEnabled::NoCollision);
			Component->SetupAttachment(RootComponent);
			if (BaseMaterial)
			{
				UMaterialInstanceDynamic* Material = UMaterialInstanceDynamic::Create(BaseMaterial, this);
				Material->SetVectorParameterValue(TEXT("Color"), ToColor(Chunk.color_rgba));
				Component->SetMaterial(0, Material);
			}
			Component->RegisterComponent();
			ComponentIndex = ChunkComponents.Add(Component);
			Instances.AddDefaulted();
			ComponentByColor.Add(Chunk.color_rgba, ComponentIndex);
		}

		FChunkSlot& Slot = Slots[Index];
		Slot.Component = ComponentIndex;
		Slot.Instance = Instances[ComponentIndex].Num();
		// The basic cube is 100 cm on a side; extents are already centimetres in Unreal axes.
		Slot.Scale = ToVector(Chunk.extents) / 100.0;
		Slot.Rest = FTransform(ToQuat(Chunk.rest_quat), ToVector(Chunk.rest_pos), Slot.Scale);
		Instances[ComponentIndex].Add(Slot.Rest);
		Bounds += Slot.Rest.GetLocation();
	}
	for (int32 ComponentIndex = 0; ComponentIndex < ChunkComponents.Num(); ++ComponentIndex)
	{
		ChunkComponents[ComponentIndex]->AddInstances(Instances[ComponentIndex], /*bShouldReturnIndices=*/false, /*bWorldSpace=*/true);
	}
	bCityBuilt = true;
	UE_LOG(LogVibeLand, Display, TEXT("city built: %d chunks in %d instanced meshes, %.1f ms; bounds %s"),
		Chunks.Num(), ChunkComponents.Num(), (FPlatformTime::Seconds() - Started) * 1000.0, *Bounds.ToString());
	OnCityBuilt.Broadcast(Bounds);
}

void AVibeCityDirector::ApplyFrame(const VlFrameView& Frame)
{
	// Assignment changes first: which body each chunk now rides.
	for (size_t i = 0; i < Frame.assignment_count; ++i)
	{
		const VlChunkAssignment& A = Frame.assignments[i];
		if (!Slots.IsValidIndex(static_cast<int32>(A.chunk)))
		{
			continue;
		}
		const int32 ChunkIndex = static_cast<int32>(A.chunk);
		FChunkSlot& Slot = Slots[ChunkIndex];
		if (Slot.Body != 0)
		{
			if (TArray<int32>* Members = BodyChunks.Find(Slot.Body))
			{
				Members->RemoveSwap(ChunkIndex);
				if (Members->Num() == 0)
				{
					BodyChunks.Remove(Slot.Body);
					BodyPoses.Remove(Slot.Body);
				}
			}
		}
		Slot.bRemoved = A.body == VL_BODY_REMOVED;
		Slot.Body = (A.body == VL_BODY_STANDING || A.body == VL_BODY_REMOVED) ? 0 : BodyKey(A.structure, A.body);
		Slot.Local = ToVector(A.local_pos);
		if (Slot.Body != 0)
		{
			BodyChunks.FindOrAdd(Slot.Body).Add(ChunkIndex);
		}
		PlaceChunk(ChunkIndex);
	}

	// Then poses of bodies that moved: rewrite their chunks.
	for (size_t i = 0; i < Frame.body_pose_count; ++i)
	{
		const VlBodyPose& P = Frame.body_poses[i];
		const uint64 Key = BodyKey(P.structure, P.body);
		BodyPoses.Add(Key, FTransform(ToQuat(P.quat), ToVector(P.pos)));
		if (const TArray<int32>* Members = BodyChunks.Find(Key))
		{
			for (const int32 ChunkIndex : *Members)
			{
				PlaceChunk(ChunkIndex);
			}
		}
	}

	for (const int32 ComponentIndex : DirtyComponents)
	{
		ChunkComponents[ComponentIndex]->MarkRenderStateDirty();
	}
	DirtyComponents.Reset();
}

void AVibeCityDirector::PlaceChunk(int32 ChunkIndex)
{
	const FChunkSlot& Slot = Slots[ChunkIndex];
	FTransform Transform;
	if (Slot.bRemoved)
	{
		Transform = HiddenTransform;
	}
	else if (Slot.Body == 0)
	{
		Transform = Slot.Rest;
	}
	else if (const FTransform* Pose = BodyPoses.Find(Slot.Body))
	{
		Transform = FTransform(Pose->GetRotation(), Pose->TransformPosition(Slot.Local), Slot.Scale);
	}
	else
	{
		return; // its body has no pose yet; the first pose places it
	}
	ChunkComponents[Slot.Component]->UpdateInstanceTransform(Slot.Instance, Transform, /*bWorldSpace=*/true, /*bMarkRenderStateDirty=*/false, /*bTeleport=*/true);
	DirtyComponents.Add(Slot.Component);
}

void AVibeCityDirector::SyncPlayers(const VlFrameView& Frame)
{
	TSet<uint32> Seen;
	for (size_t i = 0; i < Frame.remote_player_count; ++i)
	{
		const VlPlayer& Player = Frame.remote_players[i];
		Seen.Add(Player.player_id);
		TObjectPtr<UStaticMeshComponent>* Existing = PlayerComponents.Find(Player.player_id);
		UStaticMeshComponent* Component = Existing ? Existing->Get() : nullptr;
		if (!Component)
		{
			Component = NewObject<UStaticMeshComponent>(this);
			Component->SetStaticMesh(CylinderMesh);
			Component->SetMobility(EComponentMobility::Movable);
			Component->SetCollisionEnabled(ECollisionEnabled::NoCollision);
			Component->SetWorldScale3D(PlayerScale);
			if (BaseMaterial)
			{
				UMaterialInstanceDynamic* Material = UMaterialInstanceDynamic::Create(BaseMaterial, this);
				Material->SetVectorParameterValue(TEXT("Color"), FLinearColor(1.0f, 0.35f, 0.1f));
				Component->SetMaterial(0, Material);
			}
			Component->SetupAttachment(RootComponent);
			Component->RegisterComponent();
			PlayerComponents.Add(Player.player_id, Component);
			UE_LOG(LogVibeLand, Display, TEXT("remote player %u joined"), Player.player_id);
		}
		Component->SetWorldLocationAndRotation(ToVector(Player.pos), FRotator(0.0, Player.yaw, 0.0));
		LookAtPlayerOnce(ToVector(Player.pos));
	}
	for (auto It = PlayerComponents.CreateIterator(); It; ++It)
	{
		if (!Seen.Contains(It.Key()))
		{
			UE_LOG(LogVibeLand, Display, TEXT("remote player %u left"), It.Key());
			if (It.Value())
			{
				It.Value()->DestroyComponent();
			}
			It.RemoveCurrent();
		}
	}
}

void AVibeCityDirector::LookAtPlayerOnce(const FVector& PlayerPosition)
{
	// -VibeView=players: once a remote player appears, look at them from 8 m away (demos, checks).
	if (bLookedAtPlayer)
	{
		return;
	}
	FString View;
	if (!FParse::Value(FCommandLine::Get(), TEXT("VibeView="), View) || View != TEXT("players"))
	{
		bLookedAtPlayer = true;
		return;
	}
	APlayerController* Controller = GetWorld()->GetFirstPlayerController();
	APawn* Pawn = Controller ? Controller->GetPawn() : nullptr;
	if (!Pawn)
	{
		return;
	}
	bLookedAtPlayer = true;
	const FVector Eye = PlayerPosition + FVector(-700.0, -300.0, 350.0);
	Pawn->SetActorLocation(Eye);
	Controller->SetControlRotation((PlayerPosition - Eye).Rotation());
	// A scripted view holds still: an offscreen window still feeds stray mouse deltas.
	Controller->SetIgnoreLookInput(true);
	Controller->SetIgnoreMoveInput(true);
	UE_LOG(LogVibeLand, Display, TEXT("camera on remote player at %s"), *PlayerPosition.ToString());
}

void AVibeCityDirector::ShowStatus(const VlFrameView& Frame) const
{
	if (!GEngine)
	{
		return;
	}
	static const TCHAR* TransportNames[] = { TEXT("idle"), TEXT("fetching config"), TEXT("fetching manifest"), TEXT("connecting"), TEXT("connected"), TEXT("closed"), TEXT("failed") };
	const VlStats& S = Frame.stats;
	const TCHAR* Transport = Frame.transport_state < UE_ARRAY_COUNT(TransportNames) ? TransportNames[Frame.transport_state] : TEXT("?");
	const UVibeNetSubsystem* NetSubsystem = Net();
	const FString Error = NetSubsystem ? NetSubsystem->LastError() : FString();
	GEngine->AddOnScreenDebugMessage(0x5643, 0.0f, Error.IsEmpty() ? FColor::Green : FColor::Orange,
		FString::Printf(TEXT("vibe-land %s  |  player %u  |  wire %u  |  chunks %u  |  bodies %d (%d chunks)  |  players %u  |  snapshots %llu  |  fractures %llu  |  hash %llu/%llu  |  decode errors %llu%s%s"),
			Transport, S.player_id, S.city_wire, S.chunks, PosedBodies(), ChunksOnBodies(), S.remote_players, S.snapshots,
			S.fractures, S.hash_checks, S.hash_mismatches, S.decode_errors, Error.IsEmpty() ? TEXT("") : TEXT("  |  "), *Error));
}
