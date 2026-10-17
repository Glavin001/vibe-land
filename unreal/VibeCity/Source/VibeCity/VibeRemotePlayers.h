#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "vibe_client_core.h"

#include "VibeRemotePlayers.generated.h"

class UAnimSequence;
class UMaterialInstanceDynamic;
class USceneComponent;
class USkeletalMesh;
class USkeletalMeshComponent;
class UStaticMeshComponent;
class UTextRenderComponent;

/**
 * Other players, as the web draws them (scene/netEntityRenderers.ts): the Quaternius UAL mannequin
 * (/Game/VibeCity/Characters/UAL1_Standard, with its Idle_Loop / Walk_Loop / Jog_Fwd_Loop /
 * Sprint_Loop clips chosen at the web's 2 and 4 m/s, and Melee_Hook on the meleeing flag) tinted per
 * player, an HP bar, a yellow flash for 180 ms when its HP drops, a shield while spawn-protected,
 * hidden while in a car, and lying down when dead. Until the mannequin is imported a figure of
 * primitives stands in.
 */
UCLASS()
class VIBECITY_API AVibeRemotePlayers : public AActor
{
	GENERATED_BODY()

public:
	AVibeRemotePlayers();

	int32 VisiblePlayers() const;
	/** Whether the imported mannequin is in use (else the stand-in figure). */
	bool UsesMannequin() const { return Mannequin != nullptr; }

protected:
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
	virtual void Tick(float DeltaSeconds) override;

private:
	struct FAvatar
	{
		TObjectPtr<USceneComponent> Root;
		TObjectPtr<USkeletalMeshComponent> Skeletal;
		TObjectPtr<UStaticMeshComponent> Body;
		TObjectPtr<UStaticMeshComponent> Head;
		TObjectPtr<UStaticMeshComponent> Shield;
		TObjectPtr<UStaticMeshComponent> HpBack;
		TObjectPtr<UStaticMeshComponent> HpFill;
		TObjectPtr<UMaterialInstanceDynamic> Tint;
		/** The mannequin's body material (M_Main), tinted through BaseColorFactor. */
		TObjectPtr<UMaterialInstanceDynamic> Body3D;
		FLinearColor Color;
		uint32 LastHp = 100;
		double FlashUntil = 0.0;
		FString Clip;
		bool bSeen = false;
	};

	void OnFrame(const VlFrameView& Frame);
	FAvatar& AvatarFor(uint32 PlayerId);
	UAnimSequence* Anim(const TCHAR* Name);

	UPROPERTY(Transient)
	TObjectPtr<USkeletalMesh> Mannequin;
	UPROPERTY(Transient)
	TMap<FString, TObjectPtr<UAnimSequence>> Anims;
	UPROPERTY(Transient)
	TObjectPtr<UMaterialInstanceDynamic> ShieldMaterial;
	UPROPERTY(Transient)
	TObjectPtr<UMaterialInstanceDynamic> HpBackMaterial;
	UPROPERTY(Transient)
	TObjectPtr<UMaterialInstanceDynamic> HpFillMaterial;

	TMap<uint32, FAvatar> Avatars;
	FDelegateHandle FrameHandle;
};
