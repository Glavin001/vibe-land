#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "vibe_client_core.h"

#include "VibeRemotePlayers.generated.h"

class UAnimSequence;
class UBoxComponent;
class UPhysicsAsset;
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
 * hidden while in a car. Like the web's CharacterFactory: a jump / air / land state machine on the
 * player's on-ground flag (Jump_Start, Jump_Loop, Jump_Land) over the locomotion. A dead player
 * falls as the web's cosmetic ragdoll (characterAnim/Ragdoll.ts, ragdollBones.ts): the same 13 boxes
 * on the same UAL bones and 12 joints with the same limits, built as a physics asset from the
 * mannequin's reference pose, seeded with the player's last velocity and a small random spin, on
 * the city ground; until respawn. Until the mannequin is imported a figure of primitives stands in
 * (lying down when dead).
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
	/** Frames on which some player was drawn in a jump phase, and in a ragdoll (tests). */
	int32 JumpingSeen() const { return JumpFrames; }
	int32 RagdollSeen() const { return RagdollFrames; }
	/** Bodies and joints of the ragdoll built from the web's rig (tests: 13 and 12). */
	int32 RagdollBodies() const;
	int32 RagdollJoints() const;
	/** A ragdolling player's pelvis in the world, and whether its bodies have come to rest (tests). */
	TOptional<FVector> RagdollPelvis(uint32 PlayerId) const;
	bool RagdollAtRest(uint32 PlayerId) const;
	/** Tests: a player that dies standing at `Centre` (the server's capsule centre, 0.8 m over the
	 * feet) moving at `Velocity` (cm/s), with no server player behind it. Returns its id. */
	uint32 DropTestRagdoll(const FVector& Centre, const FVector& Velocity);

	/** Avatars live in a plain map, so their objects are reported to GC here (a collected tint
	 * material crashed the next Tick). */
	static void AddReferencedObjects(UObject* InThis, FReferenceCollector& Collector);

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
		/** The web's jump phases. */
		enum class EJump : uint8 { Grounded, Jumping, Airborne, Landing } Jump = EJump::Grounded;
		double ClipEndsAt = 0.0;
		bool bRagdoll = false;
		/** Where the mannequin sits under the avatar's root, restored after a ragdoll. */
		FTransform SkeletalRelative;
	};

	void PlayClip(FAvatar& A, const TCHAR* Clip, bool bLoop);
	/** The web's ragdoll rig as a physics asset on the mannequin (once). */
	UPhysicsAsset* RagdollAsset();
	void SetRagdoll(FAvatar& A, bool bOn, const FVector& Velocity);

	void OnFrame(const VlFrameView& Frame);
	FAvatar& AvatarFor(uint32 PlayerId);
	UAnimSequence* Anim(const TCHAR* Name);

	UPROPERTY(Transient)
	TObjectPtr<USkeletalMesh> Mannequin;
	UPROPERTY(Transient)
	TMap<FString, TObjectPtr<UAnimSequence>> Anims;
	UPROPERTY(Transient)
	TObjectPtr<UPhysicsAsset> RagdollPhysics;
	/** The city ground for ragdolls (server y = 0); the city's own meshes have no collision. */
	UPROPERTY(Transient)
	TObjectPtr<UBoxComponent> RagdollGround;
	UPROPERTY(Transient)
	TObjectPtr<UMaterialInstanceDynamic> ShieldMaterial;
	UPROPERTY(Transient)
	TObjectPtr<UMaterialInstanceDynamic> HpBackMaterial;
	UPROPERTY(Transient)
	TObjectPtr<UMaterialInstanceDynamic> HpFillMaterial;

	TMap<uint32, FAvatar> Avatars;
	int32 JumpFrames = 0;
	int32 RagdollFrames = 0;
	FDelegateHandle FrameHandle;
};
