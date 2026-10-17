#pragma once

#include "Containers/ArrayView.h"
#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "vibe_client_core.h"

#include "VibeNetSubsystem.generated.h"

/**
 * Owns the connection to a vibe-land server: the shared Rust client core (decoding, the wire 4
 * city stream, interpolation) and its native WebTransport adapter, behind the C ABI in
 * client-core-ffi. Positions it reports are already in Unreal space (centimetres, Z up).
 *
 * Poll once per frame from one place (AVibeCityDirector does); the frame's arrays stay valid until
 * the next poll, the chunk table until disconnect.
 */
UCLASS()
class VIBELANDNET_API UVibeNetSubsystem : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual void Deinitialize() override;

	/** Start connecting (disconnecting first if needed). False if the client could not be created. */
	bool Connect(const FString& ApiBaseUrl, const FString& MatchId);
	void Disconnect();
	bool IsConnected() const { return Client != nullptr; }

	/** Advance the client to now. Null when not connected or when the client failed. */
	const VlFrameView* Poll();

	/** The city's chunks (empty until the manifest arrived). */
	TArrayView<const VlChunk> Chunks() const;

	FString LastError() const;
	const FString& CurrentMatchId() const { return MatchId; }
	const FString& CurrentApiBaseUrl() const { return ApiBaseUrl; }

	/** The last polled frame, for HUDs and console status. */
	const VlFrameView& LastFrame() const { return Frame; }

private:
	VlClient* Client = nullptr;
	VlFrameView Frame = {};
	FString ApiBaseUrl;
	FString MatchId;
};
