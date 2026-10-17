#include "VibePlayerPawn.h"

#include "Camera/CameraComponent.h"
#include "Components/SceneComponent.h"
#include "Engine/GameInstance.h"
#include "Engine/LocalPlayer.h"
#include "Engine/World.h"
#include "EnhancedInputComponent.h"
#include "EnhancedInputSubsystems.h"
#include "GameFramework/PlayerController.h"
#include "InputAction.h"
#include "InputCoreTypes.h"
#include "InputMappingContext.h"
#include "InputModifiers.h"
#include "EngineUtils.h"
#include "VibeCityDirector.h"
#include "VibeLandNet.h"
#include "VibeNetSubsystem.h"

namespace
{
	/** Control rotation pitch in (-180, 180], as the core expects (Unreal keeps it in [0, 360)). */
	float SignedPitch(float Pitch)
	{
		return FRotator::NormalizeAxis(Pitch);
	}
}

AVibePlayerPawn::AVibePlayerPawn()
{
	PrimaryActorTick.bCanEverTick = true;
	// Before the director polls the core this frame (TG_PrePhysics too; ordered in BeginPlay), so
	// the input it sends is this frame's.
	PrimaryActorTick.TickGroup = TG_PrePhysics;

	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(RootComponent);
	// The eye: shared::constants::PLAYER_EYE_HEIGHT_M above the server's reported position.
	Camera->SetRelativeLocation(FVector(0.0, 0.0, 100.0 * VL_EYE_HEIGHT_M));
	Camera->bUsePawnControlRotation = true;
	// The web's hipfire field of view (GameWorld.tsx), horizontal in Unreal as in three.js.
	Camera->SetFieldOfView(75.0f);

	bUseControllerRotationYaw = false;
	bUseControllerRotationPitch = false;
	AutoPossessPlayer = EAutoReceiveInput::Disabled;
	SetActorEnableCollision(false);
}

UVibeNetSubsystem* AVibePlayerPawn::Net() const
{
	const UGameInstance* GameInstance = GetGameInstance();
	return GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr;
}

void AVibePlayerPawn::BeginPlay()
{
	Super::BeginPlay();
	if (UVibeNetSubsystem* NetSubsystem = Net())
	{
		FrameHandle = NetSubsystem->OnFrame.AddUObject(this, &AVibePlayerPawn::OnFrame);
	}
}

void AVibePlayerPawn::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	if (UVibeNetSubsystem* NetSubsystem = Net())
	{
		NetSubsystem->OnFrame.Remove(FrameHandle);
	}
	Super::EndPlay(EndPlayReason);
}

void AVibePlayerPawn::CreateInput()
{
	if (Mapping)
	{
		return;
	}
	auto Action = [this](const TCHAR* Name, EInputActionValueType Type)
	{
		UInputAction* A = NewObject<UInputAction>(this, Name);
		A->ValueType = Type;
		return A;
	};
	MoveAction = Action(TEXT("IA_Move"), EInputActionValueType::Axis2D);
	LookAction = Action(TEXT("IA_Look"), EInputActionValueType::Axis2D);
	JumpAction = Action(TEXT("IA_Jump"), EInputActionValueType::Boolean);
	SprintAction = Action(TEXT("IA_Sprint"), EInputActionValueType::Boolean);
	CrouchAction = Action(TEXT("IA_Crouch"), EInputActionValueType::Boolean);
	FireAction = Action(TEXT("IA_Fire"), EInputActionValueType::Boolean);
	RifleAction = Action(TEXT("IA_Rifle"), EInputActionValueType::Boolean);
	CannonAction = Action(TEXT("IA_Cannon"), EInputActionValueType::Boolean);
	MeteorAction = Action(TEXT("IA_Meteor"), EInputActionValueType::Boolean);
	CycleAction = Action(TEXT("IA_CycleWeapon"), EInputActionValueType::Axis1D);

	Mapping = NewObject<UInputMappingContext>(this, TEXT("IMC_VibeCity"));
	// Move: X right, Y forward. W/S drive Y (swizzled), S and A negated.
	auto Negate = [this]() { return NewObject<UInputModifierNegate>(Mapping); };
	auto ToY = [this]() { return NewObject<UInputModifierSwizzleAxis>(Mapping); }; // default order YXZ
	Mapping->MapKey(MoveAction, EKeys::W).Modifiers.Add(ToY());
	{
		FEnhancedActionKeyMapping& S = Mapping->MapKey(MoveAction, EKeys::S);
		S.Modifiers.Add(ToY());
		S.Modifiers.Add(Negate());
	}
	Mapping->MapKey(MoveAction, EKeys::A).Modifiers.Add(Negate());
	Mapping->MapKey(MoveAction, EKeys::D);
	// Look: mouse up looks up (the first-person template's negated Y).
	{
		FEnhancedActionKeyMapping& Look = Mapping->MapKey(LookAction, EKeys::Mouse2D);
		UInputModifierNegate* NegateY = Negate();
		NegateY->bX = false;
		NegateY->bZ = false;
		Look.Modifiers.Add(NegateY);
	}
	Mapping->MapKey(JumpAction, EKeys::SpaceBar);
	Mapping->MapKey(SprintAction, EKeys::LeftShift);
	Mapping->MapKey(CrouchAction, EKeys::C);
	Mapping->MapKey(FireAction, EKeys::LeftMouseButton);
	Mapping->MapKey(RifleAction, EKeys::One);
	Mapping->MapKey(CannonAction, EKeys::Two);
	Mapping->MapKey(MeteorAction, EKeys::Three);
	Mapping->MapKey(CycleAction, EKeys::MouseWheelAxis);
}

void AVibePlayerPawn::PawnClientRestart()
{
	Super::PawnClientRestart();
	CreateInput();
	const APlayerController* PC = Cast<APlayerController>(GetController());
	const ULocalPlayer* LocalPlayer = PC ? PC->GetLocalPlayer() : nullptr;
	if (UEnhancedInputLocalPlayerSubsystem* Input = LocalPlayer ? LocalPlayer->GetSubsystem<UEnhancedInputLocalPlayerSubsystem>() : nullptr)
	{
		Input->ClearAllMappings();
		Input->AddMappingContext(Mapping, 0);
	}
}

void AVibePlayerPawn::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
	Super::SetupPlayerInputComponent(PlayerInputComponent);
	CreateInput();
	UEnhancedInputComponent* Input = Cast<UEnhancedInputComponent>(PlayerInputComponent);
	if (!Input)
	{
		UE_LOG(LogVibeLand, Error, TEXT("the player input component is not an Enhanced Input component; no controls"));
		return;
	}
	Input->BindAction(MoveAction, ETriggerEvent::Triggered, this, &AVibePlayerPawn::OnMove);
	Input->BindAction(MoveAction, ETriggerEvent::Completed, this, &AVibePlayerPawn::OnMoveStopped);
	Input->BindAction(LookAction, ETriggerEvent::Triggered, this, &AVibePlayerPawn::OnLook);
	Input->BindActionValueLambda(JumpAction, ETriggerEvent::Started, [this](const FInputActionValue&) { OnButton(VL_BTN_JUMP, true); });
	Input->BindActionValueLambda(JumpAction, ETriggerEvent::Completed, [this](const FInputActionValue&) { OnButton(VL_BTN_JUMP, false); });
	Input->BindActionValueLambda(SprintAction, ETriggerEvent::Started, [this](const FInputActionValue&) { OnButton(VL_BTN_SPRINT, true); });
	Input->BindActionValueLambda(SprintAction, ETriggerEvent::Completed, [this](const FInputActionValue&) { OnButton(VL_BTN_SPRINT, false); });
	Input->BindActionValueLambda(CrouchAction, ETriggerEvent::Started, [this](const FInputActionValue&) { OnButton(VL_BTN_CROUCH, true); });
	Input->BindActionValueLambda(CrouchAction, ETriggerEvent::Completed, [this](const FInputActionValue&) { OnButton(VL_BTN_CROUCH, false); });
	Input->BindAction(FireAction, ETriggerEvent::Started, this, &AVibePlayerPawn::OnFire);
	Input->BindAction(FireAction, ETriggerEvent::Completed, this, &AVibePlayerPawn::OnFireStopped);
	Input->BindActionValueLambda(RifleAction, ETriggerEvent::Started, [this](const FInputActionValue&) { SelectWeapon(VL_WEAPON_RIFLE); });
	Input->BindActionValueLambda(CannonAction, ETriggerEvent::Started, [this](const FInputActionValue&) { SelectWeapon(VL_WEAPON_CANNON); });
	Input->BindActionValueLambda(MeteorAction, ETriggerEvent::Started, [this](const FInputActionValue&) { SelectWeapon(VL_WEAPON_METEOR); });
	Input->BindAction(CycleAction, ETriggerEvent::Triggered, this, &AVibePlayerPawn::CycleWeapon);
}

void AVibePlayerPawn::OnMove(const FInputActionValue& Value)
{
	MoveAxes = Value.Get<FVector2D>();
}

void AVibePlayerPawn::OnMoveStopped(const FInputActionValue&)
{
	MoveAxes = FVector2D::ZeroVector;
}

void AVibePlayerPawn::OnLook(const FInputActionValue& Value)
{
	const FVector2D Look = Value.Get<FVector2D>();
	AddControllerYawInput(Look.X);
	AddControllerPitchInput(Look.Y);
}

void AVibePlayerPawn::OnFire(const FInputActionValue&)
{
	bFireHeld = true;
}

void AVibePlayerPawn::OnFireStopped(const FInputActionValue&)
{
	bFireHeld = false;
}

void AVibePlayerPawn::OnButton(uint32 Bit, bool bDown)
{
	Buttons = bDown ? (Buttons | Bit) : (Buttons & ~Bit);
}

const TCHAR* AVibePlayerPawn::WeaponName(uint32 Weapon)
{
	switch (Weapon)
	{
	case VL_WEAPON_RIFLE: return TEXT("Rifle");
	case VL_WEAPON_CANNON: return TEXT("Cannon");
	case VL_WEAPON_METEOR: return TEXT("Meteor strike");
	default: return TEXT("?");
	}
}

void AVibePlayerPawn::SelectWeapon(uint32 InWeapon)
{
	CurrentWeapon = InWeapon;
}

void AVibePlayerPawn::CycleWeapon(const FInputActionValue& Value)
{
	// The web's cycle (city/shotMode.ts): rifle, cannon, meteor.
	static const uint32 Order[] = { VL_WEAPON_RIFLE, VL_WEAPON_CANNON, VL_WEAPON_METEOR };
	const float Step = Value.Get<float>();
	if (FMath::IsNearlyZero(Step))
	{
		return;
	}
	int32 Index = 0;
	for (int32 i = 0; i < UE_ARRAY_COUNT(Order); ++i)
	{
		if (Order[i] == CurrentWeapon)
		{
			Index = i;
		}
	}
	Index = (Index + (Step > 0.0f ? 1 : -1) + UE_ARRAY_COUNT(Order)) % UE_ARRAY_COUNT(Order);
	CurrentWeapon = Order[Index];
}

void AVibePlayerPawn::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	if (!bOrderedBeforeDirector)
	{
		// The director polls the core; this frame's input must be in before it does. (It is spawned
		// by the game mode's StartPlay, possibly after this pawn's BeginPlay.)
		for (TActorIterator<AVibeCityDirector> It(GetWorld()); It; ++It)
		{
			It->AddTickPrerequisiteActor(this);
			bOrderedBeforeDirector = true;
		}
	}
	UVibeNetSubsystem* NetSubsystem = Net();
	const AController* PC = GetController();
	if (!NetSubsystem || !PC)
	{
		return;
	}
	const FRotator View = PC->GetControlRotation();
	VlInput Input = {};
	Input.move_x = static_cast<float>(MoveAxes.X);
	Input.move_y = static_cast<float>(MoveAxes.Y);
	Input.yaw = static_cast<float>(View.Yaw);
	Input.pitch = SignedPitch(static_cast<float>(View.Pitch));
	Input.buttons = Buttons;
	NetSubsystem->SetInput(Input);
	if (bFireHeld && bJoined)
	{
		// The core repeats at most at the server's fire interval and stamps the shot.
		NetSubsystem->Fire(CurrentWeapon);
	}
}

void AVibePlayerPawn::OnFrame(const VlFrameView& Frame)
{
	const VlPlayer& Me = Frame.local.player;
	if (!(Me.flags & VL_PLAYER_VALID))
	{
		return;
	}
	SetActorLocation(FVector(Me.pos[0], Me.pos[1], Me.pos[2]));
	if (!bJoined)
	{
		bJoined = true;
		// Face where the server spawned us.
		if (AController* PC = GetController())
		{
			PC->SetControlRotation(FRotator(Me.pitch, Me.yaw, 0.0f));
		}
		UE_LOG(LogVibeLand, Display, TEXT("playing as player %u at %s"), Me.player_id, *GetActorLocation().ToString());
	}
}
