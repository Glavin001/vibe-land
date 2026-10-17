#include "VibePlayerPawn.h"

#include "Camera/CameraComponent.h"
#include "Components/SceneComponent.h"
#include "Engine/GameInstance.h"
#include "Engine/LocalPlayer.h"
#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
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
#include "VibeVehicles.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "VibeLandNet.h"
#include "VibeNetSubsystem.h"

namespace
{
	// scene/GameWorld.tsx: three.js fields of view are vertical.
	constexpr float HipfireVerticalFov = 75.0f;
	constexpr float ScopeVerticalFov = 45.0f;
	constexpr float AimFovDamp = 12.0f;
	constexpr float AimLookMultiplier = 0.45f;
	// city/cityReset.ts.
	constexpr double CityResetCooldownS = 1.0;
	// scene/aerialFlight.ts and App.tsx (aerialSpeed 30).
	constexpr double AerialSpeedCmS = 3000.0;
	constexpr double AerialSprintMultiplier = 3.0;
	constexpr double AerialMaxStepS = 0.1;
	// shared::constants::VEHICLE_INTERACT_RADIUS_M.
	constexpr double VehicleInteractRadiusCm = 400.0;
	// input/resolver.ts: the chase camera's pitch and its return to centre.
	constexpr float ChaseDefaultPitchDeg = 8.594367f; // 0.15 rad
	constexpr float ChasePitchMinDeg = -20.053523f;   // -0.35 rad
	constexpr float ChasePitchMaxDeg = 34.377468f;    // 0.6 rad
	constexpr float ChaseYawReturnDegS = 143.239449f; // 2.5 rad/s
	constexpr float ChasePitchReturnDegS = 85.943669f; // 1.5 rad/s
	constexpr double ChaseIdleS = 0.3;

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
	// Set each frame from the web's vertical field of view and the viewport's aspect (UpdateFieldOfView).
	Camera->SetFieldOfView(90.0f);
	// The web draws no motion blur.
	Camera->PostProcessSettings.bOverride_MotionBlurAmount = true;
	Camera->PostProcessSettings.MotionBlurAmount = 0.0f;

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
	AimAction = Action(TEXT("IA_Aim"), EInputActionValueType::Boolean);
	ResetAction = Action(TEXT("IA_ResetCity"), EInputActionValueType::Boolean);
	MeleeAction = Action(TEXT("IA_Melee"), EInputActionValueType::Boolean);
	InteractAction = Action(TEXT("IA_Interact"), EInputActionValueType::Boolean);
	AerialAction = Action(TEXT("IA_Aerial"), EInputActionValueType::Boolean);

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
	Mapping->MapKey(AimAction, EKeys::RightMouseButton);
	Mapping->MapKey(ResetAction, EKeys::R);
	Mapping->MapKey(MeleeAction, EKeys::V);
	Mapping->MapKey(InteractAction, EKeys::E);
	Mapping->MapKey(AerialAction, EKeys::N);
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
	Input->BindActionValueLambda(AimAction, ETriggerEvent::Started, [this](const FInputActionValue&) { bAiming = true; });
	Input->BindActionValueLambda(AimAction, ETriggerEvent::Completed, [this](const FInputActionValue&) { bAiming = false; });
	// R: in a car, the car's reset button (held like the others); on foot, the city reset.
	Input->BindActionValueLambda(ResetAction, ETriggerEvent::Started, [this](const FInputActionValue&)
	{
		if (bInVehicle)
		{
			OnButton(VL_BTN_RELOAD, true);
		}
		else if (!bAerial)
		{
			ResetCity();
		}
	});
	Input->BindActionValueLambda(ResetAction, ETriggerEvent::Completed, [this](const FInputActionValue&) { OnButton(VL_BTN_RELOAD, false); });
	Input->BindActionValueLambda(InteractAction, ETriggerEvent::Started, [this](const FInputActionValue&) { Interact(); });
	Input->BindActionValueLambda(MeleeAction, ETriggerEvent::Started, [this](const FInputActionValue&)
	{
		if (UVibeNetSubsystem* NetSubsystem = Net(); NetSubsystem && bJoined && !bAerial)
		{
			NetSubsystem->Melee();
		}
	});
	Input->BindActionValueLambda(AerialAction, ETriggerEvent::Started, [this](const FInputActionValue&) { ToggleAerial(); });
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
	const FVector2D Look = Value.Get<FVector2D>() * (bAiming ? AimLookMultiplier : 1.0f);
	if (bInVehicle)
	{
		// In a car the mouse orbits the chase camera about the car (input/resolver.ts); the legacy
		// input scale (2.5 degrees per unit) keeps the feel of on-foot look.
		ChaseYawOffset += Look.X * 2.5f;
		ChasePitch = FMath::Clamp(ChasePitch + Look.Y * 2.5f, ChasePitchMinDeg, ChasePitchMaxDeg);
		LastChaseLookSeconds = FPlatformTime::Seconds();
		return;
	}
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

void AVibePlayerPawn::ResetCity()
{
	const double Now = FPlatformTime::Seconds();
	UVibeNetSubsystem* NetSubsystem = Net();
	if (!NetSubsystem || !NetSubsystem->IsConnected() || Now - LastResetSeconds < CityResetCooldownS)
	{
		return;
	}
	LastResetSeconds = Now;
	const FString Url = FString::Printf(TEXT("%s/city-reset/%s"), *NetSubsystem->CurrentApiBaseUrl(), *FGenericPlatformHttp::UrlEncode(NetSubsystem->CurrentMatchId()));
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Url);
	Request->SetVerb(TEXT("POST"));
	Request->OnProcessRequestComplete().BindLambda([Url](FHttpRequestPtr, FHttpResponsePtr Response, bool bOk)
	{
		UE_LOG(LogVibeLand, Display, TEXT("city reset %s: %s"), *Url, bOk && Response ? *FString::FromInt(Response->GetResponseCode()) : TEXT("failed"));
	});
	Request->ProcessRequest();
}

void AVibePlayerPawn::Interact()
{
	UVibeNetSubsystem* NetSubsystem = Net();
	if (!NetSubsystem || !bJoined || bAerial)
	{
		return;
	}
	if (bInVehicle)
	{
		NetSubsystem->ExitVehicle();
		return;
	}
	TActorIterator<AVibeVehicles> Vehicles(GetWorld());
	if (TOptional<uint32> Car = Vehicles ? Vehicles->NearestCar(GetActorLocation(), VehicleInteractRadiusCm) : TOptional<uint32>())
	{
		DrivenCar = *Car;
		bChaseValid = false;
		NetSubsystem->EnterVehicle(*Car);
	}
}

void AVibePlayerPawn::FollowCar(float DeltaSeconds)
{
	// The web's chase camera (scene/GameWorld.tsx): focus 1 m above the chassis, 6 m behind along the
	// car's heading plus the mouse's orbit, 1 m higher, smoothed (rates 12 and 18 per second).
	TActorIterator<AVibeVehicles> Vehicles(GetWorld());
	TOptional<FVector> Chassis = Vehicles ? Vehicles->CarPosition(DrivenCar) : TOptional<FVector>();
	TOptional<FQuat> Rotation = Vehicles ? Vehicles->CarRotation(DrivenCar) : TOptional<FQuat>();
	AController* PC = GetController();
	if (!Chassis || !Rotation || !PC)
	{
		return;
	}
	if (!bChaseValid)
	{
		ChaseYawOffset = 0.0f;
		ChasePitch = ChaseDefaultPitchDeg;
	}
	if (FPlatformTime::Seconds() - LastChaseLookSeconds > ChaseIdleS)
	{
		ChaseYawOffset = FMath::FixedTurn(ChaseYawOffset, 0.0f, ChaseYawReturnDegS * DeltaSeconds);
		ChasePitch = FMath::FixedTurn(ChasePitch, ChaseDefaultPitchDeg, ChasePitchReturnDegS * DeltaSeconds);
	}
	const float OrbitYaw = static_cast<float>(Rotation->Rotator().Yaw) + ChaseYawOffset;
	const double FollowCm = 600.0;
	const FVector Focus = *Chassis + FVector(0.0, 0.0, 100.0);
	const FVector Back = FRotator(0.0, OrbitYaw, 0.0).Vector() * (FMath::Cos(FMath::DegreesToRadians(ChasePitch)) * FollowCm);
	const FVector Target = Focus - Back + FVector(0.0, 0.0, FMath::Sin(FMath::DegreesToRadians(ChasePitch)) * FollowCm + 100.0);
	if (!bChaseValid)
	{
		ChaseFocus = Focus;
		ChaseEye = Target;
		bChaseValid = true;
	}
	ChaseFocus += (Focus - ChaseFocus) * FMath::Min(DeltaSeconds * 12.0f, 1.0f);
	ChaseEye += (Target - ChaseEye) * FMath::Min(DeltaSeconds * 18.0f, 1.0f);
	SetActorLocation(ChaseEye - Camera->GetRelativeLocation());
	PC->SetControlRotation((ChaseFocus - ChaseEye).Rotation());
}

void AVibePlayerPawn::ToggleAerial()
{
	if (!bJoined)
	{
		return;
	}
	const AController* PC = GetController();
	if (!bAerial)
	{
		bAerial = true;
		AerialEye = Camera->GetComponentLocation();
		return;
	}
	bAerial = false;
	// Drop the player where the camera is (the server places its capsule centre there; the eye is
	// the eye height above it).
	if (UVibeNetSubsystem* NetSubsystem = Net(); NetSubsystem && PC)
	{
		const FRotator View = PC->GetControlRotation();
		NetSubsystem->CameraDrop(AerialEye - FVector(0.0, 0.0, 100.0 * VL_EYE_HEIGHT_M), View.Yaw, SignedPitch(View.Pitch));
	}
}

void AVibePlayerPawn::FlyAerial(float DeltaSeconds)
{
	const AController* PC = GetController();
	if (!PC)
	{
		return;
	}
	const FRotator View = PC->GetControlRotation();
	const FVector Forward = View.Vector();
	const FVector Right = FRotator(0.0, View.Yaw, 0.0).RotateVector(FVector::RightVector);
	const double Vertical = ((Buttons & VL_BTN_JUMP) ? 1.0 : 0.0) - ((Buttons & VL_BTN_CROUCH) ? 1.0 : 0.0);
	FVector Move = Forward * MoveAxes.Y + Right * MoveAxes.X + FVector::UpVector * Vertical;
	const double Length = FMath::Max(1.0, Move.Size());
	const double Step = FMath::Clamp(static_cast<double>(DeltaSeconds), 0.0, AerialMaxStepS)
		* AerialSpeedCmS * ((Buttons & VL_BTN_SPRINT) ? AerialSprintMultiplier : 1.0) / Length;
	AerialEye += Move * Step;
	SetActorLocation(AerialEye - Camera->GetRelativeLocation());
}

void AVibePlayerPawn::UpdateFieldOfView(float DeltaSeconds)
{
	const float Target = bAiming ? ScopeVerticalFov : HipfireVerticalFov;
	VerticalFov = FMath::Lerp(Target, VerticalFov, FMath::Exp(-AimFovDamp * DeltaSeconds));
	// Unreal's field of view is horizontal: keep the web's vertical one at any aspect.
	FVector2D Size(16.0, 9.0);
	if (GEngine && GEngine->GameViewport)
	{
		GEngine->GameViewport->GetViewportSize(Size);
	}
	const double Aspect = Size.Y > 0.0 ? Size.X / Size.Y : 16.0 / 9.0;
	const double Horizontal = 2.0 * FMath::Atan(FMath::Tan(FMath::DegreesToRadians(VerticalFov) * 0.5) * Aspect);
	Camera->SetFieldOfView(static_cast<float>(FMath::RadiansToDegrees(Horizontal)));
}

void AVibePlayerPawn::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	UpdateFieldOfView(DeltaSeconds);
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
	Input.yaw = static_cast<float>(View.Yaw);
	Input.pitch = SignedPitch(static_cast<float>(View.Pitch));
	if (bAerial)
	{
		// The camera flies; the player gets neutral input (it stands where it was).
		FlyAerial(DeltaSeconds);
		NetSubsystem->SetInput(Input);
		return;
	}
	Input.move_x = static_cast<float>(MoveAxes.X);
	Input.move_y = static_cast<float>(MoveAxes.Y);
	Input.buttons = Buttons;
	NetSubsystem->SetInput(Input);
	if (bFireHeld && bJoined && !bInVehicle)
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
	bInVehicle = (Me.state_flags & VL_STATE_IN_VEHICLE) != 0;
	if (bInVehicle)
	{
		FollowCar(static_cast<float>(GetWorld()->GetDeltaSeconds()));
	}
	else if (!bAerial)
	{
		SetActorLocation(FVector(Me.pos[0], Me.pos[1], Me.pos[2]));
	}
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
