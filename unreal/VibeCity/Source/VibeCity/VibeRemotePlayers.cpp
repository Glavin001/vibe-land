#include "VibeRemotePlayers.h"

#include "Animation/AnimSequence.h"
#include "Components/BoxComponent.h"
#include "PhysicalMaterials/PhysicalMaterial.h"
#include "PhysicsEngine/BodySetup.h"
#include "PhysicsEngine/PhysicsAsset.h"
#include "PhysicsEngine/PhysicsConstraintTemplate.h"
#include "PhysicsEngine/SkeletalBodySetup.h"
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

	// The web's ragdoll rig (scene/characterAnim/ragdollBones.ts): per part, the bone it rides, the
	// bone whose origin gives its long axis ("" = straight up), and its half extents in metres at the
	// reference height (1.67 m head to foot), hy along the long axis.
	struct FRagdollPart { const TCHAR* Bone; const TCHAR* Tip; float Hx, Hy, Hz; float Spin; };
	const FRagdollPart RagdollRigParts[] = {
		{ TEXT("pelvis"),     TEXT("spine_01"),   0.16f,  0.11f,  0.11f, 1.2f },
		{ TEXT("spine_02"),   TEXT("neck_01"),    0.175f, 0.225f, 0.11f, 1.2f },
		{ TEXT("Head"),       TEXT(""),           0.11f,  0.11f,  0.11f, 0.6f },
		{ TEXT("upperarm_l"), TEXT("lowerarm_l"), 0.07f,  0.16f,  0.07f, 0.6f },
		{ TEXT("lowerarm_l"), TEXT("hand_l"),     0.07f,  0.14f,  0.07f, 0.6f },
		{ TEXT("upperarm_r"), TEXT("lowerarm_r"), 0.07f,  0.16f,  0.07f, 0.6f },
		{ TEXT("lowerarm_r"), TEXT("hand_r"),     0.07f,  0.14f,  0.07f, 0.6f },
		{ TEXT("thigh_l"),    TEXT("calf_l"),     0.08f,  0.21f,  0.08f, 0.6f },
		{ TEXT("calf_l"),     TEXT("foot_l"),     0.08f,  0.21f,  0.08f, 0.6f },
		{ TEXT("foot_l"),     TEXT("ball_l"),     0.05f,  0.10f,  0.06f, 0.6f },
		{ TEXT("thigh_r"),    TEXT("calf_r"),     0.08f,  0.21f,  0.08f, 0.6f },
		{ TEXT("calf_r"),     TEXT("foot_r"),     0.08f,  0.21f,  0.08f, 0.6f },
		{ TEXT("foot_r"),     TEXT("ball_r"),     0.05f,  0.10f,  0.06f, 0.6f },
	};
	// Its joints: (b1, b2) as part indices, pivoting at b1's bone; ball joints with a swing cone and
	// twist half-range about b1's long axis, hinges about b1's body Z with [lo, hi] (radians).
	struct FRagdollJoint { int32 B1, B2; bool bHinge; float A, B; };
	const FRagdollJoint RagdollRigJoints[] = {
		{ 1, 0, false, 0.6f, 0.5f },   // spine
		{ 2, 1, false, 0.7f, 0.8f },   // neck
		{ 3, 1, false, 1.4f, 1.0f },   // shoulders
		{ 5, 1, false, 1.4f, 1.0f },
		{ 4, 3, true, -2.4f, 0.1f },   // elbows
		{ 6, 5, true, -2.4f, 0.1f },
		{ 7, 0, false, 1.1f, 0.5f },   // hips
		{ 10, 0, false, 1.1f, 0.5f },
		{ 8, 7, true, -2.6f, 0.05f },  // knees
		{ 11, 10, true, -2.6f, 0.05f },
		{ 9, 8, true, -0.7f, 0.7f },   // ankles
		{ 12, 11, true, -0.7f, 0.7f },
	};
	// Ragdoll.ts spawnRagdollBody (shared wasm_api.rs): damping 0.02, friction 0.6, restitution 0.3.
	constexpr float RagdollDamping = 0.02f;

	/** A bone's reference-pose transform in component space. */
	FTransform RefComponentSpace(const FReferenceSkeleton& Ref, int32 Bone)
	{
		FTransform T = FTransform::Identity;
		for (int32 B = Bone; B != INDEX_NONE; B = Ref.GetParentIndex(B))
		{
			T = T * Ref.GetRefBonePose()[B];
		}
		return T;
	}

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

void AVibeRemotePlayers::AddReferencedObjects(UObject* InThis, FReferenceCollector& Collector)
{
	Super::AddReferencedObjects(InThis, Collector);
	for (TPair<uint32, FAvatar>& Pair : CastChecked<AVibeRemotePlayers>(InThis)->Avatars)
	{
		FAvatar& A = Pair.Value;
		Collector.AddReferencedObject(A.Root);
		Collector.AddReferencedObject(A.Skeletal);
		Collector.AddReferencedObject(A.Body);
		Collector.AddReferencedObject(A.Head);
		Collector.AddReferencedObject(A.Shield);
		Collector.AddReferencedObject(A.HpBack);
		Collector.AddReferencedObject(A.HpFill);
		Collector.AddReferencedObject(A.Tint);
		Collector.AddReferencedObject(A.Body3D);
	}
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
		A.SkeletalRelative = A.Skeletal->GetRelativeTransform();
		if (UPhysicsAsset* Physics = RagdollAsset())
		{
			A.Skeletal->SetPhysicsAsset(Physics, true);
		}
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
			FRotator(0.0, P.yaw, (bDead && !A.Skeletal) ? 90.0 : 0.0));
		A.Shield->SetVisibility(!bInVehicle && (P.state_flags & VL_STATE_SPAWN_PROTECTED) != 0);
		const float Hp = FMath::Clamp(P.hp / 100.0f, 0.0f, 1.0f);
		A.HpFill->SetRelativeScale3D(FVector(0.02, FMath::Max(0.001f, 0.76f * Hp), 0.06));
		A.HpBack->SetVisibility(!bInVehicle && !bDead);
		A.HpFill->SetVisibility(!bInVehicle && !bDead);
		if (A.Skeletal)
		{
			const FVector Velocity(P.vel[0], P.vel[1], P.vel[2]);
			if (bDead != A.bRagdoll)
			{
				SetRagdoll(A, bDead, Velocity);
			}
			if (!bDead)
			{
				// The web's jump phases over the locomotion (characterAnim/CharacterFactory.ts).
				const bool bGround = (P.state_flags & VL_STATE_ON_GROUND) != 0;
				const bool bClipDone = Now >= A.ClipEndsAt;
				using EJump = FAvatar::EJump;
				switch (A.Jump)
				{
				case EJump::Grounded:
					if (!bGround) { PlayClip(A, TEXT("Jump_Start"), false); A.Jump = EJump::Jumping; }
					break;
				case EJump::Jumping:
					if (bGround) { PlayClip(A, TEXT("Jump_Land"), false); A.Jump = EJump::Landing; }
					else if (bClipDone) { PlayClip(A, TEXT("Jump_Loop"), true); A.Jump = EJump::Airborne; }
					break;
				case EJump::Airborne:
					if (bGround) { PlayClip(A, TEXT("Jump_Land"), false); A.Jump = EJump::Landing; }
					break;
				case EJump::Landing:
					if (!bGround) { PlayClip(A, TEXT("Jump_Start"), false); A.Jump = EJump::Jumping; }
					else if (bClipDone) { A.Jump = EJump::Grounded; }
					break;
				}
				if (A.Jump == EJump::Grounded)
				{
					const double Speed = FVector2D(Velocity.X, Velocity.Y).Size();
					const bool bMelee = (P.state_flags & VL_STATE_MELEEING) != 0;
					const TCHAR* Clip = bMelee ? TEXT("Melee_Hook")
						: Speed < IdleCmS ? TEXT("Idle_Loop")
						: Speed < JogCmS ? TEXT("Walk_Loop")
						: Speed < SprintCmS ? TEXT("Jog_Fwd_Loop") : TEXT("Sprint_Loop");
					if (A.Clip != Clip)
					{
						PlayClip(A, Clip, !bMelee);
					}
				}
			}
		}
	}
	bool bJumping = false, bRagdoll = false;
	for (const TPair<uint32, FAvatar>& Pair : Avatars)
	{
		bJumping |= Pair.Value.bSeen && Pair.Value.Jump != FAvatar::EJump::Grounded;
		bRagdoll |= Pair.Value.bSeen && Pair.Value.bRagdoll;
	}
	JumpFrames += bJumping ? 1 : 0;
	RagdollFrames += bRagdoll ? 1 : 0;
	for (TPair<uint32, FAvatar>& Pair : Avatars)
	{
		if (!Pair.Value.bSeen && Pair.Value.Root)
		{
			Pair.Value.Root->SetVisibility(false, true);
		}
	}
}

void AVibeRemotePlayers::PlayClip(FAvatar& A, const TCHAR* Clip, bool bLoop)
{
	A.Clip = Clip;
	UAnimSequence* Seq = Anim(Clip);
	if (!Seq)
	{
		A.ClipEndsAt = 0.0; // not imported: treat as finished
		return;
	}
	A.Skeletal->PlayAnimation(Seq, bLoop);
	A.ClipEndsAt = FPlatformTime::Seconds() + Seq->GetPlayLength();
}

UPhysicsAsset* AVibeRemotePlayers::RagdollAsset()
{
	if (RagdollPhysics || !Mannequin)
	{
		return RagdollPhysics;
	}
	const FReferenceSkeleton& Ref = Mannequin->GetRefSkeleton();
	const int32 HeadBone = Ref.FindBoneIndex(TEXT("Head"));
	const int32 FootBone = Ref.FindBoneIndex(TEXT("foot_l"));
	if (HeadBone == INDEX_NONE || FootBone == INDEX_NONE)
	{
		return nullptr;
	}
	// Ragdoll.ts: the rig is sized for 1.67 m head to foot; scaled to this mannequin (cm per metre).
	const double Span = RefComponentSpace(Ref, HeadBone).GetLocation().Z - RefComponentSpace(Ref, FootBone).GetLocation().Z;
	const double S = Span > 10.0 ? Span / 1.67 : 100.0;

	UPhysicsAsset* Physics = NewObject<UPhysicsAsset>(this, TEXT("PA_UAL1_Ragdoll"));
	UPhysicalMaterial* Surface = NewObject<UPhysicalMaterial>(Physics);
	Surface->Friction = 0.6f;
	Surface->Restitution = 0.3f;
	TArray<FTransform> BoneCs;
	TArray<FVector> Dir;
	for (const FRagdollPart& Part : RagdollRigParts)
	{
		const int32 Bone = Ref.FindBoneIndex(Part.Bone);
		if (Bone == INDEX_NONE)
		{
			UE_LOG(LogTemp, Warning, TEXT("ragdoll: the mannequin has no bone %s"), Part.Bone);
			return nullptr;
		}
		const FTransform Cs = RefComponentSpace(Ref, Bone);
		const int32 TipBone = *Part.Tip ? Ref.FindBoneIndex(Part.Tip) : INDEX_NONE;
		const FVector Tip = TipBone != INDEX_NONE ? RefComponentSpace(Ref, TipBone).GetLocation()
			: Cs.GetLocation() + FVector(0.0, 0.0, Part.Hy * 2.0 * S);
		const FVector Along = (Tip - Cs.GetLocation()).GetSafeNormal(UE_SMALL_NUMBER, FVector::UpVector);
		BoneCs.Add(Cs);
		Dir.Add(Along);
		// The box: centred halfway to the tip, its Z along the bone, as Ragdoll.ts places it.
		FKBoxElem Box(2.0 * Part.Hx * S, 2.0 * Part.Hz * S, 2.0 * Part.Hy * S);
		Box.Center = Cs.InverseTransformPosition((Cs.GetLocation() + Tip) * 0.5);
		Box.Rotation = (Cs.GetRotation().Inverse() * FQuat::FindBetweenNormals(FVector::UpVector, Along)).Rotator();
		USkeletalBodySetup* Body = NewObject<USkeletalBodySetup>(Physics);
		Body->BoneName = Part.Bone;
		Body->PhysicsType = PhysType_Default;
		Body->AggGeom.BoxElems.Add(Box);
		Body->PhysMaterial = Surface;
		Body->DefaultInstance.LinearDamping = RagdollDamping;
		Body->DefaultInstance.AngularDamping = RagdollDamping;
		Physics->SkeletalBodySetups.Add(Body);
	}
	for (const FRagdollJoint& J : RagdollRigJoints)
	{
		UPhysicsConstraintTemplate* Joint = NewObject<UPhysicsConstraintTemplate>(Physics);
		FConstraintInstance& C = Joint->DefaultInstance;
		C.ConstraintBone1 = RagdollRigParts[J.B1].Bone;
		C.ConstraintBone2 = RagdollRigParts[J.B2].Bone;
		C.JointName = C.ConstraintBone1;
		// The pivot is b1's bone origin. The frame's X (Chaos's twist axis) is b1's long axis for a ball
		// joint, and for a hinge its body Z: the axis the web's ragdoll rotates its body Y onto the bone
		// carries world Z to, which is Unreal's X (coords: server z is Unreal x).
		const FQuat ToBone = FQuat::FindBetweenNormals(FVector::UpVector, Dir[J.B1]);
		const FVector Axis = J.bHinge ? ToBone.RotateVector(FVector::ForwardVector) : Dir[J.B1];
		FQuat Frame = FQuat::FindBetweenNormals(FVector::ForwardVector, Axis);
		const FVector Pivot = BoneCs[J.B1].GetLocation();
		if (J.bHinge)
		{
			// [lo, hi] as a symmetric twist range about its centre.
			Frame = Frame * FQuat(FVector::ForwardVector, -(J.A + J.B) * 0.5f);
			C.SetAngularTwistLimit(ACM_Limited, FMath::RadiansToDegrees((J.B - J.A) * 0.5f));
			C.SetAngularSwing1Limit(ACM_Locked, 0.0f);
			C.SetAngularSwing2Limit(ACM_Locked, 0.0f);
		}
		else
		{
			C.SetAngularSwing1Limit(ACM_Limited, FMath::RadiansToDegrees(J.A));
			C.SetAngularSwing2Limit(ACM_Limited, FMath::RadiansToDegrees(J.A));
			C.SetAngularTwistLimit(ACM_Limited, FMath::RadiansToDegrees(J.B));
		}
		const FQuat Pre = FQuat::FindBetweenNormals(FVector::ForwardVector, Axis);
		C.SetRefFrame(EConstraintFrame::Frame1, FTransform(BoneCs[J.B1].GetRotation().Inverse() * Pre, FVector::ZeroVector));
		C.SetRefFrame(EConstraintFrame::Frame2, FTransform(BoneCs[J.B2].GetRotation().Inverse() * Frame,
			BoneCs[J.B2].InverseTransformPosition(Pivot)));
		C.SetDisableCollision(true);
		Physics->ConstraintSetup.Add(Joint);
	}
	Physics->UpdateBodySetupIndexMap();
	Physics->UpdateBoundsBodiesArray();
	// Jointed parts never touch each other, as the web's joints are built (contacts_enabled(false)).
	// The constraint's own flag above does not reach Chaos for a physics asset built at runtime; the
	// asset's collision table does. Left colliding, a thigh and the pelvis (which overlap where they
	// meet) push apart every step and the body never comes to rest.
	for (const FRagdollJoint& J : RagdollRigJoints)
	{
		Physics->DisableCollision(J.B1, J.B2);
	}
	RagdollPhysics = Physics;
	UE_LOG(LogTemp, Display, TEXT("ragdoll: %d bodies, %d joints, %.1f cm per rig metre"), Physics->SkeletalBodySetups.Num(),
		Physics->ConstraintSetup.Num(), S);
	return RagdollPhysics;
}

void AVibeRemotePlayers::SetRagdoll(FAvatar& A, bool bOn, const FVector& Velocity)
{
	A.bRagdoll = bOn;
	if (bOn && RagdollPhysics)
	{
		// The web's death (cosmetic ragdolls on by default): every body takes the player's last velocity,
		// so it falls as one, and a random spin up to 1.2 rad/s (pelvis, torso) or 0.6 rad/s (the rest).
		if (!RagdollGround)
		{
			RagdollGround = NewObject<UBoxComponent>(this, TEXT("RagdollGround"));
			RagdollGround->SetupAttachment(RootComponent);
			RagdollGround->SetBoxExtent(FVector(1.0e6, 1.0e6, 500.0));
			RagdollGround->SetWorldLocation(FVector(0.0, 0.0, -500.0));
			RagdollGround->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
			RagdollGround->SetCollisionObjectType(ECC_WorldStatic);
			RagdollGround->SetCollisionResponseToAllChannels(ECR_Ignore);
			RagdollGround->SetCollisionResponseToChannel(ECC_PhysicsBody, ECR_Block);
			RagdollGround->RegisterComponent();
		}
		A.Skeletal->Stop();
		A.Skeletal->SetCollisionProfileName(TEXT("Ragdoll"));
		A.Skeletal->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
		A.Skeletal->SetCollisionResponseToChannel(ECC_WorldStatic, ECR_Block);
		A.Skeletal->SetSimulatePhysics(true);
		A.Skeletal->SetAllPhysicsLinearVelocity(Velocity);
		for (int32 i = 0; i < A.Skeletal->Bodies.Num() && i < UE_ARRAY_COUNT(RagdollRigParts); ++i)
		{
			const float Spin = RagdollRigParts[i].Spin;
			if (FBodyInstance* Body = A.Skeletal->Bodies[i])
			{
				Body->SetAngularVelocityInRadians(FVector(FMath::FRandRange(-Spin, Spin), FMath::FRandRange(-Spin, Spin), FMath::FRandRange(-Spin, Spin)), false);
			}
		}
		A.Skeletal->WakeAllRigidBodies();
		return;
	}
	if (bOn)
	{
		PlayClip(A, TEXT("Death01"), false); // no rig (bones missing): the web's death clip
		return;
	}
	if (A.Skeletal->IsSimulatingPhysics())
	{
		A.Skeletal->SetSimulatePhysics(false);
		A.Skeletal->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		A.Skeletal->AttachToComponent(A.Root, FAttachmentTransformRules::KeepRelativeTransform);
		A.Skeletal->SetRelativeTransform(A.SkeletalRelative);
	}
	A.Jump = FAvatar::EJump::Grounded;
	A.Clip.Reset();
}

int32 AVibeRemotePlayers::RagdollBodies() const
{
	return RagdollPhysics ? RagdollPhysics->SkeletalBodySetups.Num() : 0;
}

int32 AVibeRemotePlayers::RagdollJoints() const
{
	return RagdollPhysics ? RagdollPhysics->ConstraintSetup.Num() : 0;
}

TOptional<FVector> AVibeRemotePlayers::RagdollPelvis(uint32 PlayerId) const
{
	const FAvatar* A = Avatars.Find(PlayerId);
	return A && A->Skeletal && A->bRagdoll && A->Skeletal->IsSimulatingPhysics()
		? TOptional<FVector>(A->Skeletal->GetBoneLocation(TEXT("pelvis"))) : TOptional<FVector>();
}

uint32 AVibeRemotePlayers::DropTestRagdoll(const FVector& Centre, const FVector& Velocity)
{
	static uint32 NextTestId = 0x7fff0000;
	const uint32 Id = NextTestId++;
	FAvatar& A = AvatarFor(Id);
	A.Root->SetWorldLocationAndRotation(Centre, FRotator::ZeroRotator);
	if (A.Skeletal)
	{
		SetRagdoll(A, true, Velocity);
	}
	return Id;
}

bool AVibeRemotePlayers::RagdollAtRest(uint32 PlayerId) const
{
	const FAvatar* A = Avatars.Find(PlayerId);
	return A && A->Skeletal && A->Skeletal->IsSimulatingPhysics() && !A->Skeletal->IsAnyRigidBodyAwake();
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
