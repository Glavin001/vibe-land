#include "VibeCityPlayerController.h"

#include "Components/InputComponent.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/IConsoleManager.h"
#include "InputCoreTypes.h"
#include "Kismet/GameplayStatics.h"
#include "VibeLandNet.h"
#include "VibeSettings.h"
#include "Engine/GameViewportClient.h"
#include "Widgets/SWidget.h"

void AVibeCityPlayerController::BeginPlay()
{
	Super::BeginPlay();
	if (!IsLocalController())
	{
		return;
	}
	if (FSlateApplication::IsInitialized())
	{
		ActivationHandle = FSlateApplication::Get().OnApplicationActivationStateChanged().AddUObject(
			this, &AVibeCityPlayerController::OnApplicationActivationChanged);
	}
	if (GEngine && GEngine->GameViewport)
	{
		SettingsWidget = FVibeSettings::MakePanel();
		SettingsWidget->SetVisibility(EVisibility::Collapsed);
		GEngine->GameViewport->AddViewportWidgetContent(SettingsWidget.ToSharedRef(), 10);
	}
	// Start captured, as bCaptureMouseOnLaunch does, but through the same path as a click so the
	// state below always matches what the viewport is doing.
	CaptureCursor();
}

void AVibeCityPlayerController::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	if (ActivationHandle.IsValid() && FSlateApplication::IsInitialized())
	{
		FSlateApplication::Get().OnApplicationActivationStateChanged().Remove(ActivationHandle);
	}
	ActivationHandle.Reset();
	if (SettingsWidget && GEngine && GEngine->GameViewport)
	{
		GEngine->GameViewport->RemoveViewportWidgetContent(SettingsWidget.ToSharedRef());
	}
	SettingsWidget.Reset();
	Super::EndPlay(EndPlayReason);
}

void AVibeCityPlayerController::SetupInputComponent()
{
	Super::SetupInputComponent();
	// Keys rather than Enhanced Input actions: these are the window's cursor contract, not game
	// controls, and must work whatever mapping context is active.
	InputComponent->BindKey(EKeys::Escape, IE_Pressed, this, &AVibeCityPlayerController::FreeCursor);
	FInputKeyBinding& Click = InputComponent->BindKey(EKeys::LeftMouseButton, IE_Pressed, this, &AVibeCityPlayerController::CaptureCursor);
	// Let game bindings (shooting, from M2) still see clicks made while captured.
	Click.bConsumeInput = false;
}

void AVibeCityPlayerController::FreeCursor()
{
	if (Cursor == ECursor::Free)
	{
		return;
	}
	Cursor = ECursor::Free;
	bShowMouseCursor = true;
	// GameAndUI releases the capture and captures only while a button is held (the click that
	// takes the cursor back); it never grabs the mouse on focus.
	FInputModeGameAndUI Mode;
	Mode.SetLockMouseToViewportBehavior(EMouseLockMode::DoNotLock);
	Mode.SetHideCursorDuringCapture(false);
	SetInputMode(Mode);
	// Counted, so it composes with scripted views that also ignore look input (-VibeView).
	SetIgnoreLookInput(true);
	ShowSettings(true);
	UE_LOG(LogVibeLand, Display, TEXT("cursor free (click the window to look around)"));
}

void AVibeCityPlayerController::CaptureCursor()
{
	if (Cursor == ECursor::Captured)
	{
		return; // a click while playing
	}
	const bool bWasFree = Cursor == ECursor::Free;
	Cursor = ECursor::Captured;
	ShowSettings(false);
	bShowMouseCursor = false;
	FInputModeGameOnly Mode;
	// The click that captures the cursor is not also a game input.
	Mode.SetConsumeCaptureMouseDown(true);
	SetInputMode(Mode);
	if (bWasFree)
	{
		SetIgnoreLookInput(false);
		UE_LOG(LogVibeLand, Display, TEXT("cursor captured (Esc frees it)"));
	}
}

bool AVibeCityPlayerController::SettingsShown() const
{
	return SettingsWidget && SettingsWidget->GetVisibility() != EVisibility::Collapsed;
}

void AVibeCityPlayerController::ShowSettings(bool bShow)
{
	if (SettingsWidget)
	{
		SettingsWidget->SetVisibility(bShow ? EVisibility::SelfHitTestInvisible : EVisibility::Collapsed);
	}
}

void AVibeCityPlayerController::OnApplicationActivationChanged(bool bIsActive)
{
	// Leaving the app frees the cursor; coming back leaves it free until a click.
	if (!bIsActive)
	{
		FreeCursor();
	}
}

void AVibeCityPlayerController::PlayerTick(float DeltaTime)
{
	Super::PlayerTick(DeltaTime);
	if (Cursor == ECursor::Free && GEngine)
	{
		GEngine->AddOnScreenDebugMessage(0x5644, 0.0f, FColor::White, TEXT("Cursor free: click the window to look around"));
	}
}

namespace
{
	FAutoConsoleCommandWithWorldAndArgs GVibeCursorCommand(
		TEXT("vibe.cursor"),
		TEXT("vibe.cursor free|capture: free or capture the mouse cursor (Esc frees it, a click captures it)."),
		FConsoleCommandWithWorldAndArgsDelegate::CreateLambda([](const TArray<FString>& Args, UWorld* World)
		{
			AVibeCityPlayerController* Controller = World ? Cast<AVibeCityPlayerController>(UGameplayStatics::GetPlayerController(World, 0)) : nullptr;
			if (!Controller)
			{
				UE_LOG(LogVibeLand, Warning, TEXT("vibe.cursor: no VibeCity player controller"));
				return;
			}
			if (Args.Num() > 0 && Args[0] == TEXT("free"))
			{
				Controller->FreeCursor();
			}
			else if (Args.Num() > 0 && Args[0] == TEXT("capture"))
			{
				Controller->CaptureCursor();
			}
			UE_LOG(LogVibeLand, Display, TEXT("vibe.cursor: %s"), Controller->IsCursorFree() ? TEXT("free") : TEXT("captured"));
		}));
}
