#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "vibe_client_core.h"

#include "VibeCityBatteries.generated.h"

class UMaterialInstanceDynamic;
class UMaterialInterface;
class UPointLightComponent;
class UStaticMesh;
class UStaticMeshComponent;

/**
 * The energy batteries players drop where they die (the core's VlFrameView::batteries, from the
 * server's PKT_BATTERY_SYNC), drawn as the web draws them (netEntityRenderers.ts BatteriesRenderer):
 * a gold cell sized by its energy on the ground, glowing and pulsing; here the glow is a small
 * point light, so a battery lights the street around it. The server picks one up when a player
 * walks into it.
 */
UCLASS()
class VIBELANDCITY_API AVibeCityBatteries : public AActor
{
	GENERATED_BODY()

public:
	AVibeCityBatteries();

	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
	virtual void Tick(float DeltaSeconds) override;

	/** For tests: batteries drawn now. */
	int32 Drawn() const { return Cells.Num(); }

private:
	struct FCell
	{
		TObjectPtr<UStaticMeshComponent> Body;
		TObjectPtr<UPointLightComponent> Light;
		TObjectPtr<UMaterialInstanceDynamic> Material;
		float Energy = 0.0f;
		float Phase = 0.0f;
	};

	void OnFrame(const VlFrameView& Frame);

	UPROPERTY(Transient)
	TObjectPtr<UStaticMesh> Cylinder;
	UPROPERTY(Transient)
	TObjectPtr<UMaterialInterface> CellMaterial;
	/** Components owned by cells (kept here for the GC). */
	UPROPERTY(Transient)
	TArray<TObjectPtr<UObject>> Owned;

	TMap<uint32, FCell> Cells;
	FDelegateHandle FrameHandle;
	float Time = 0.0f;
};
