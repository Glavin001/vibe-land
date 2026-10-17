#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerController.h"

#include "VibeCityPlayerController.generated.h"

/**
 * The usual desktop FPS cursor contract, which `-game` does not provide on its own (the engine's
 * defaults capture the mouse permanently and take it back whenever the window regains focus):
 *   * Escape frees the cursor (shown, not captured, no mouse-look);
 *   * a click in the window captures it again (the click itself is consumed, never a game input);
 *   * the app losing focus (Cmd-Tab, Mission Control, another window) frees it, and returning to
 *     the window does not grab it until you click.
 * Console: vibe.cursor free|capture.
 */
UCLASS()
class VIBECITY_API AVibeCityPlayerController : public APlayerController
{
	GENERATED_BODY()

public:
	/** Show the cursor and stop capturing the mouse. */
	void FreeCursor();
	/** Hide the cursor and capture the mouse for mouse-look. */
	void CaptureCursor();
	bool IsCursorFree() const { return Cursor == ECursor::Free; }

protected:
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
	virtual void SetupInputComponent() override;
	virtual void PlayerTick(float DeltaTime) override;

private:
	void OnApplicationActivationChanged(bool bIsActive);

	enum class ECursor : uint8 { Unset, Free, Captured };
	ECursor Cursor = ECursor::Unset;
	FDelegateHandle ActivationHandle;
};
