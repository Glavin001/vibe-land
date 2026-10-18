#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "vibe_client_core.h"

#include "VibeDynamicBodies.generated.h"

class UMaterialInstanceDynamic;
class UPointLightComponent;
class UStaticMeshComponent;

/**
 * The game snapshot's free bodies (cannonballs, meteors) and meteor flights, from the core's frame.
 *
 * Bodies are drawn at their interpolated poses with their server shapes (VlDynamicBody). A meteor
 * is drawn on the arc its launch packet gives (VlMeteor: start + v t + g t^2 / 2) from the moment it
 * is announced, glowing, until its body appears among the snapshot's bodies, then as that body:
 * the web's meteorPlacement.ts (its arc start is beyond the snapshot's range).
 */
UCLASS()
class VIBECITY_API AVibeDynamicBodies : public AActor
{
	GENERATED_BODY()

public:
	AVibeDynamicBodies();

	int32 VisibleBodies() const { return Shown; }
	int32 FlyingMeteors() const { return Flights.Num(); }
	/** Meteors that have landed (surge and scorch made), and scorch marks on the ground now (tests). */
	int32 Landings() const { return LandingCount; }
	int32 ScorchMarks() const { return Scorches.Num(); }
	int32 DebrisFieldCount() const { return DebrisFields.Num(); }

protected:
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
	virtual void Tick(float DeltaSeconds) override;

private:
	struct FFlight
	{
		VlMeteor Meteor;
		double LaunchedAt = 0.0;
		TObjectPtr<UStaticMeshComponent> Mesh;
		TObjectPtr<UPointLightComponent> Light;
		/** A sphere stretched behind the meteor along its direction of travel: its fire trail. */
		TObjectPtr<UStaticMeshComponent> Trail;
		TObjectPtr<UMaterialInstanceDynamic> TrailMaterial;
		/** Its own basalt, so its glow can cool on its own. */
		TObjectPtr<UMaterialInstanceDynamic> Material;
		FVector LastPos = FVector::ZeroVector;
		double LastPosAt = 0.0;
		bool bLanded = false;
	};

	/** Where a meteor lands: a ground surge of dust rolling out and a scorch mark. */
	void Land(FFlight& F);

	/** Draws the meteor at `Pos` moving at `Velocity` (cm/s), its trail behind it. */
	void PlaceMeteor(FFlight& F, const FVector& Pos, const FVector& Velocity);

	void OnFrame(const VlFrameView& Frame);
	UStaticMeshComponent* Body(int32 Index, bool bSphere);
	UStaticMeshComponent* NewMesh(UStaticMesh* Mesh, UMaterialInterface* Material, const FString& Name);

	UPROPERTY(Transient)
	TObjectPtr<UStaticMesh> SphereMesh;
	UPROPERTY(Transient)
	TObjectPtr<UStaticMesh> CubeMesh;
	UPROPERTY(Transient)
	TObjectPtr<UMaterialInstanceDynamic> BallMaterial;
	UPROPERTY(Transient)
	TObjectPtr<UMaterialInstanceDynamic> MeteorMaterial;
	UPROPERTY(Transient)
	TObjectPtr<UMaterialInterface> TrailBase;

	TArray<TObjectPtr<UStaticMeshComponent>> Spheres;
	TArray<TObjectPtr<UStaticMeshComponent>> Boxes;
	TMap<uint32, FFlight> Flights;
	UPROPERTY(Transient)
	TObjectPtr<UMaterialInterface> ScorchBase;
	UPROPERTY(Transient)
	TArray<TObjectPtr<class UDecalComponent>> Scorches;
	/** Debris fields where meteors landed (M_VibeCityRubbleDecal), each fading in as the debris
	 * comes down. */
	UPROPERTY(Transient)
	TObjectPtr<UMaterialInterface> RubbleDecalBase;
	UPROPERTY(Transient)
	TArray<TObjectPtr<class UDecalComponent>> DebrisFields;
	UPROPERTY(Transient)
	TArray<TObjectPtr<UMaterialInstanceDynamic>> DebrisFieldMaterials;
	TArray<double> DebrisFieldBorn;
	int32 LandingCount = 0;
	TSet<uint32> BodiesSeen;
	int32 Shown = 0;
	FDelegateHandle FrameHandle;
};
