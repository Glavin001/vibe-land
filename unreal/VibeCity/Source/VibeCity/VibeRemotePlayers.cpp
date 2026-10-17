#include "VibeRemotePlayers.h"

#include "Animation/AnimSequence.h"
#include "Components/SceneComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/GameInstance.h"
#include "Engine/SkeletalMesh.h"
#include "Engine/StaticMesh.h"
#include "Kismet/GameplayStatics.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "VibeNetSubsystem.h"

namespace
{
	// scene/netEntityRenderers.ts.
	const uint32 PlayerColors[] = { 0x00ff88, 0xff4444, 0x4488ff, 0xffaa00, 0xff44ff, 0x44ffff, 0xaaff44, 0xff8844 };
	constexpr double HitFlashS = 0.18;
	const FLinearColor FlashColor = FLinearColor(FColor(0xff, 0xd7, 0x00));
	// characterAnim/profile.ts: walk below 2 m/s, jog below 4, sprint above.
	constexpr double JogCmS = 200.0;
	constexpr double SprintCmS = 400.0;
	constexpr double IdleCmS = 20.0;
	// The server's position is the capsule's centre: half a segment plus a radius above its feet
	// (MoveConfig: 0.45 + 0.35 m).
	constexpr double FeetBelowCentreCm = 80.0;

	FLinearColor Rgb(uint32 Rgb)
	{
		return FLinearColor(FColor((Rgb >> 16) & 0xff, (Rgb >> 8) & 0xff, Rgb & 0xff));
	}
}

AVibeRemotePlayers::AVibeRemotePlayers()
{
	PrimaryActorTick.bCanEverTick = true;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
}

void AVibeRemotePlayers::BeginPlay()
{
	Super::BeginPlay();
	Mannequin = LoadObject<USkeletalMesh>(nullptr, TEXT("/Game/VibeCity/Characters/UAL1_Standard.UAL1_Standard"), nullptr, LOAD_NoWarn | LOAD_Quiet);
	UMaterialInterface* Base = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	ShieldMaterial = UMaterialInstanceDynamic::Create(Base, this);
	ShieldMaterial->SetVectorParameterValue(TEXT("Color"), FLinearColor(0.4f, 0.8f, 1.0f));
	HpBackMaterial = UMaterialInstanceDynamic::Create(Base, this);
	HpBackMaterial->SetVectorParameterValue(TEXT("Color"), FLinearColor(0.05f, 0.05f, 0.05f));
	HpFillMaterial = UMaterialInstanceDynamic::Create(Base, this);
	HpFillMaterial->SetVectorParameterValue(TEXT("Color"), FLinearColor(0.85f, 0.15f, 0.15f));
	const UGameInstance* GameInstance = GetGameInstance();
	if (UVibeNetSubsystem* Net = GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr)
	{
		FrameHandle = Net->OnFrame.AddUObject(this, &AVibeRemotePlayers::OnFrame);
	}
}

void AVibeRemotePlayers::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	const UGameInstance* GameInstance = GetGameInstance();
	if (UVibeNetSubsystem* Net = GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr)
	{
		Net->OnFrame.Remove(FrameHandle);
	}
	Super::EndPlay(EndPlayReason);
}

UAnimSequence* AVibeRemotePlayers::Anim(const TCHAR* Name)
{
	if (TObjectPtr<UAnimSequence>* Found = Anims.Find(Name))
	{
		return *Found;
	}
	UAnimSequence* A = LoadObject<UAnimSequence>(nullptr, *FString::Printf(TEXT("/Game/VibeCity/Characters/Anims/%s.%s"), Name, Name), nullptr, LOAD_NoWarn | LOAD_Quiet);
	Anims.Add(Name, A);
	return A;
}

AVibeRemotePlayers::FAvatar& AVibeRemotePlayers::AvatarFor(uint32 PlayerId)
{
	if (FAvatar* Found = Avatars.Find(PlayerId))
	{
		return *Found;
	}
	FAvatar& A = Avatars.Add(PlayerId);
	A.Color = Rgb(PlayerColors[PlayerId % UE_ARRAY_COUNT(PlayerColors)]);
	auto Scene = [this](USceneComponent* Parent, const FString& Name)
	{
		USceneComponent* C = NewObject<USceneComponent>(this, *Name);
		C->SetMobility(EComponentMobility::Movable);
		C->SetupAttachment(Parent);
		C->RegisterComponent();
		return C;
	};
	auto Shape = [this](USceneComponent* Parent, const TCHAR* Mesh, UMaterialInterface* Material, const FString& Name, const FVector& At, const FVector& Scale)
	{
		UStaticMeshComponent* C = NewObject<UStaticMeshComponent>(this, *Name);
		C->SetStaticMesh(LoadObject<UStaticMesh>(nullptr, Mesh));
		C->SetMaterial(0, Material);
		C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		C->SetMobility(EComponentMobility::Movable);
		C->SetupAttachment(Parent);
		C->SetRelativeLocation(At);
		C->SetRelativeScale3D(Scale);
		C->RegisterComponent();
		return C;
	};
	A.Root = Scene(RootComponent, FString::Printf(TEXT("Player%u"), PlayerId));
	UMaterialInterface* Base = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	A.Tint = UMaterialInstanceDynamic::Create(Base, this);
	A.Tint->SetVectorParameterValue(TEXT("Color"), A.Color);
	if (Mannequin)
	{
		A.Skeletal = NewObject<USkeletalMeshComponent>(this, *FString::Printf(TEXT("Player%uMesh"), PlayerId));
		A.Skeletal->SetSkeletalMesh(Mannequin);
		A.Skeletal->SetupAttachment(A.Root);
		// The mannequin's feet at the capsule's bottom; it faces +Y as imported from glTF.
		A.Skeletal->SetRelativeLocationAndRotation(FVector(0.0, 0.0, -FeetBelowCentreCm), FRotator(0.0, -90.0, 0.0));
		A.Skeletal->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		A.Skeletal->RegisterComponent();
		// The web tints the character's main material per player; the joints keep their colour.
		for (int32 M = 0; M < A.Skeletal->GetNumMaterials(); ++M)
		{
			const UMaterialInterface* Source = A.Skeletal->GetMaterial(M);
			if (Source && Source->GetName().Contains(TEXT("Main")))
			{
				A.Body3D = A.Skeletal->CreateDynamicMaterialInstance(M);
				if (A.Body3D)
				{
					A.Body3D->SetVectorParameterValue(TEXT("BaseColorFactor"), A.Color);
				}
			}
		}
	}
	else
	{
		// Stand-in: a 1.8 m figure (body and head), tinted.
		A.Body = Shape(A.Root, TEXT("/Engine/BasicShapes/Cylinder.Cylinder"), A.Tint, FString::Printf(TEXT("Player%uBody"), PlayerId),
			FVector(0.0, 0.0, -FeetBelowCentreCm + 75.0), FVector(0.5, 0.36, 1.5));
		A.Head = Shape(A.Root, TEXT("/Engine/BasicShapes/Sphere.Sphere"), A.Tint, FString::Printf(TEXT("Player%uHead"), PlayerId),
			FVector(0.0, 0.0, -FeetBelowCentreCm + 165.0), FVector(0.28));
	}
	A.Shield = Shape(A.Root, TEXT("/Engine/BasicShapes/Sphere.Sphere"), ShieldMaterial, FString::Printf(TEXT("Player%uShield"), PlayerId),
		FVector(0.0, 0.0, 10.0), FVector(2.1, 2.1, 2.4));
	A.Shield->SetVisibility(false);
	A.HpBack = Shape(A.Root, TEXT("/Engine/BasicShapes/Cube.Cube"), HpBackMaterial, FString::Printf(TEXT("Player%uHpBack"), PlayerId),
		FVector(0.0, 0.0, 135.0), FVector(0.02, 0.8, 0.08));
	A.HpFill = Shape(A.Root, TEXT("/Engine/BasicShapes/Cube.Cube"), HpFillMaterial, FString::Printf(TEXT("Player%uHpFill"), PlayerId),
		FVector(-1.5, 0.0, 135.0), FVector(0.02, 0.76, 0.06));
	return A;
}

void AVibeRemotePlayers::OnFrame(const VlFrameView& Frame)
{
	const double Now = FPlatformTime::Seconds();
	for (TPair<uint32, FAvatar>& Pair : Avatars)
	{
		Pair.Value.bSeen = false;
	}
	for (size_t i = 0; i < Frame.remote_player_count; ++i)
	{
		const VlPlayer& P = Frame.remote_players[i];
		FAvatar& A = AvatarFor(P.player_id);
		A.bSeen = true;
		if (P.hp < A.LastHp)
		{
			A.FlashUntil = Now + HitFlashS;
		}
		A.LastHp = P.hp;
		const bool bDead = (P.state_flags & VL_STATE_DEAD) != 0;
		const bool bInVehicle = (P.state_flags & VL_STATE_IN_VEHICLE) != 0;
		A.Root->SetVisibility(!bInVehicle, true);
		A.Root->SetWorldLocationAndRotation(FVector(P.pos[0], P.pos[1], P.pos[2]),
			FRotator(0.0, P.yaw, bDead ? 90.0 : 0.0));
		A.Shield->SetVisibility(!bInVehicle && (P.state_flags & VL_STATE_SPAWN_PROTECTED) != 0);
		const float Hp = FMath::Clamp(P.hp / 100.0f, 0.0f, 1.0f);
		A.HpFill->SetRelativeScale3D(FVector(0.02, FMath::Max(0.001f, 0.76f * Hp), 0.06));
		A.HpBack->SetVisibility(!bInVehicle && !bDead);
		A.HpFill->SetVisibility(!bInVehicle && !bDead);
		if (A.Skeletal)
		{
			const double Speed = FVector2D(P.vel[0], P.vel[1]).Size();
			const TCHAR* Clip = (P.state_flags & VL_STATE_MELEEING) ? TEXT("Melee_Hook")
				: Speed < IdleCmS ? TEXT("Idle_Loop")
				: Speed < JogCmS ? TEXT("Walk_Loop")
				: Speed < SprintCmS ? TEXT("Jog_Fwd_Loop") : TEXT("Sprint_Loop");
			if (A.Clip != Clip)
			{
				if (UAnimSequence* Seq = Anim(Clip))
				{
					A.Skeletal->PlayAnimation(Seq, FCString::Strcmp(Clip, TEXT("Melee_Hook")) != 0);
				}
				A.Clip = Clip;
			}
		}
	}
	for (TPair<uint32, FAvatar>& Pair : Avatars)
	{
		if (!Pair.Value.bSeen && Pair.Value.Root)
		{
			Pair.Value.Root->SetVisibility(false, true);
		}
	}
}

void AVibeRemotePlayers::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	const double Now = FPlatformTime::Seconds();
	for (TPair<uint32, FAvatar>& Pair : Avatars)
	{
		FAvatar& A = Pair.Value;
		const float Flash = A.FlashUntil > Now ? static_cast<float>((A.FlashUntil - Now) / HitFlashS) : 0.0f;
		const FLinearColor Shown = FMath::Lerp(A.Color, FlashColor, Flash);
		A.Tint->SetVectorParameterValue(TEXT("Color"), Shown);
		if (A.Body3D)
		{
			A.Body3D->SetVectorParameterValue(TEXT("BaseColorFactor"), Shown);
		}
		// The HP bar faces the camera (yaw only).
		if (APlayerCameraManager* Camera = UGameplayStatics::GetPlayerCameraManager(this, 0))
		{
			const FVector To = Camera->GetCameraLocation() - A.Root->GetComponentLocation();
			const FRotator Face(0.0, To.Rotation().Yaw, 0.0);
			A.HpBack->SetWorldRotation(Face);
			A.HpFill->SetWorldRotation(Face);
		}
	}
}

int32 AVibeRemotePlayers::VisiblePlayers() const
{
	int32 Count = 0;
	for (const TPair<uint32, FAvatar>& Pair : Avatars)
	{
		Count += Pair.Value.bSeen ? 1 : 0;
	}
	return Count;
}
