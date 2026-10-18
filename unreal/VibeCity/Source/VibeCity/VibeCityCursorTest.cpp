// VibeCity.Cursor: the desktop cursor contract of AVibeCityPlayerController, driven through Slate's
// entry points for platform input (the calls FMacApplication makes for real key presses, clicks and
// app activation changes), so the whole route is exercised: Slate -> game viewport -> player input
// -> the controller's key bindings and activation handler.
//
// Run in the game (it needs the game viewport and the VibeCity player controller):
//   UnrealEditor VibeCity.uproject -game -windowed \
//     -ExecCmds="Automation RunTests VibeCity.Cursor; Quit"

#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/World.h"
#include "Framework/Application/SlateApplication.h"
#include "InputCoreTypes.h"
#include "Kismet/GameplayStatics.h"
#include "Misc/AutomationTest.h"
#include "Tests/AutomationCommon.h"
#include "VibeCityPlayerController.h"
#include "Widgets/SViewport.h"
#include "Widgets/SWindow.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
	AVibeCityPlayerController* GameController()
	{
		if (!GEngine)
		{
			return nullptr;
		}
		for (const FWorldContext& Context : GEngine->GetWorldContexts())
		{
			if ((Context.WorldType == EWorldType::Game || Context.WorldType == EWorldType::PIE) && Context.World())
			{
				if (AVibeCityPlayerController* Controller = Cast<AVibeCityPlayerController>(UGameplayStatics::GetPlayerController(Context.World(), 0)))
				{
					return Controller;
				}
			}
		}
		return nullptr;
	}

	void PressKey(const FKey& Key)
	{
		FSlateApplication& Slate = FSlateApplication::Get();
		const FKeyEvent Event(Key, FModifierKeysState(), Slate.GetUserIndexForKeyboard(), false, 0, 0);
		Slate.ProcessKeyDownEvent(Event);
		Slate.ProcessKeyUpEvent(Event);
	}

	/** A left click at the centre of the game viewport, as the platform reports one. */
	bool ClickViewport()
	{
		UGameViewportClient* Viewport = GEngine ? GEngine->GameViewport : nullptr;
		TSharedPtr<SViewport> Widget = Viewport ? Viewport->GetGameViewportWidget() : nullptr;
		TSharedPtr<SWindow> Window = Viewport ? Viewport->GetWindow() : nullptr;
		if (!Widget || !Window)
		{
			return false;
		}
		const FVector2D Centre = Widget->GetTickSpaceGeometry().GetAbsolutePositionAtCoordinates(FVector2D(0.5, 0.5));
		FSlateApplication& Slate = FSlateApplication::Get();
		const FPointerEvent Down(Slate.GetUserIndexForMouse(), FSlateApplication::CursorPointerIndex, Centre, Centre,
			TSet<FKey>({ EKeys::LeftMouseButton }), EKeys::LeftMouseButton, 0.0f, FModifierKeysState());
		Slate.ProcessMouseButtonDownEvent(Window->GetNativeWindow(), Down);
		const FPointerEvent Up(Slate.GetUserIndexForMouse(), FSlateApplication::CursorPointerIndex, Centre, Centre,
			TSet<FKey>(), EKeys::LeftMouseButton, 0.0f, FModifierKeysState());
		Slate.ProcessMouseButtonUpEvent(Up);
		return true;
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityCursorTest, "VibeCity.Cursor",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityCursorTest::RunTest(const FString& Parameters)
{
	// Each step acts, then the next (a frame or more later, once input has been processed) checks.
	auto Expect = [this](const TCHAR* Step, bool bFree)
	{
		AVibeCityPlayerController* Controller = GameController();
		if (!TestNotNull(TEXT("VibeCity player controller"), Controller))
		{
			return;
		}
		TestEqual(FString::Printf(TEXT("%s: cursor free"), Step), Controller->IsCursorFree(), bFree);
		TestEqual(FString::Printf(TEXT("%s: cursor shown"), Step), (bool)Controller->bShowMouseCursor, bFree);
		TestEqual(FString::Printf(TEXT("%s: mouse-look ignored"), Step), Controller->IsLookInputIgnored(), bFree);
	};

	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([]() { return GameController() != nullptr && FSlateApplication::IsInitialized(); }));
	// Start from a known state: where OS focus is when the test begins (a window launched from a
	// script may already have lost it, which frees the cursor) is not the test's to decide.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this]() { TestTrue(TEXT("clicked the viewport"), ClickViewport()); return true; }));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.2f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([Expect]() { Expect(TEXT("after the first click"), false); PressKey(EKeys::Escape); return true; }));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.2f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([Expect]() { Expect(TEXT("after Escape"), true); PressKey(EKeys::Escape); return true; }));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.2f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Expect]() { Expect(TEXT("after a second Escape"), true); TestTrue(TEXT("clicked the viewport"), ClickViewport()); return true; }));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.2f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Expect]() { Expect(TEXT("after a click"), false); TestTrue(TEXT("clicked the viewport"), ClickViewport()); return true; }));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.2f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([Expect]() { Expect(TEXT("after a click while captured"), false); FSlateApplication::Get().ProcessApplicationActivationEvent(false); return true; }));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.2f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([Expect]() { Expect(TEXT("after the app deactivated"), true); FSlateApplication::Get().ProcessApplicationActivationEvent(true); return true; }));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.2f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Expect]() { Expect(TEXT("after the app reactivated"), true); TestTrue(TEXT("clicked the viewport"), ClickViewport()); return true; }));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.2f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([Expect]() { Expect(TEXT("after a click on return"), false); return true; }));
	return true;
}

#endif
