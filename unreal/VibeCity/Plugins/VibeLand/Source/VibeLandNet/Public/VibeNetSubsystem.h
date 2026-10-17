#pragma once

#include "Containers/ArrayView.h"
#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "vibe_client_core.h"

#include "VibeNetSubsystem.generated.h"

/** Broadcast right after each successful poll, with that frame (valid until the next poll). */
DECLARE_MULTICAST_DELEGATE_OneParam(FOnVibeFrame, const VlFrameView& /*Frame*/);

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

	/** Fired after each successful Poll: the local player places its camera, the HUD and effects read
	 * the frame's events. */
	FOnVibeFrame OnFrame;

	/** What the local player is doing (Unreal space: degrees, axes in [-1, 1]); held until changed and
	 * sent as 60 Hz input frames by the next polls. */
	void SetInput(const VlInput& Input);

	/** Fire a weapon (VL_WEAPON_*) along the view last given to SetInput. Returns the shot id, or 0
	 * when nothing was fired (not playing yet, or inside the fire interval). */
	uint32 Fire(uint32 Weapon);

	/** Swing a melee attack along the view last given to SetInput. Returns the swing id, or 0 when
	 * nothing was sent (not playing, or inside the server's cooldown). */
	uint32 Melee();

	/** Put the player at a pose (Unreal space, degrees): leaving the aerial camera. */
	void CameraDrop(const FVector& Position, float YawDeg, float PitchDeg);

	/** Ask to drive the car with `Handle` (VlCar::handle), or leave the one entered. */
	void EnterVehicle(uint32 Handle);
	void ExitVehicle();

	/** A car's geometry hash (its metadata is <api>/vehicle-assets/<hash>/metadata.json) and its
	 * configuration JSON; empty until its asset has arrived (VL_EVENT_VEHICLE_ASSET). */
	FString VehicleGeometryHash(uint32 Handle) const;
	FString VehicleConfiguration(uint32 Handle) const;

	/** The city's chunks (empty until the manifest arrived). */
	TArrayView<const VlChunk> Chunks() const;

	/** Every chunk's mesh as the core's flat arrays (false until the manifest arrived). Valid until
	 * the client is destroyed. */
	bool ChunkMeshes(VlMeshView& Out) const;

	/** Every chunk's catalog materials, in chunk-table order (empty until the manifest arrived). */
	TArrayView<const VlChunkSurface> ChunkSurfaces() const;

	FString LastError() const;
	const FString& CurrentMatchId() const { return MatchId; }
	const FString& CurrentApiBaseUrl() const { return ApiBaseUrl; }

	/** The last polled frame, for HUDs and console status. */
	const VlFrameView& LastFrame() const { return Frame; }

private:
	void DropForReconnect(double Now);

	VlClient* Client = nullptr;
	/** Connected by the game (not by vibe.disconnect): a dropped session is rejoined. */
	bool bWantConnected = false;
	double ReconnectAt = 0.0;
	double ReconnectDelayS = 2.0;
	VlFrameView Frame = {};
	FString ApiBaseUrl;
	FString MatchId;
};
