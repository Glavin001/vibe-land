#pragma once

#include "CoreMinimal.h"
#include "ProceduralMeshComponent.h"
#include "vibe_client_core.h"

/**
 * The city's standing chunks merged per 32 m cell, as the director draws them and as the import
 * step (VibeLandEditor's VibeCityImport) bakes them: one place decides which cell a chunk is in and
 * what triangles it adds, so an imported cell is exactly the runtime one.
 */
namespace VibeCityCells
{
	/** Cell edge (cm): the web merges per 32 m render cell (client/src/scene/cityChunkMesh.ts). */
	constexpr double CellSizeCm = 3200.0;

	/** The cell a chunk standing at `RestPos` (Unreal space) belongs to. */
	VIBELANDCITY_API FIntPoint CellKey(const FVector& RestPos);

	/** A chunk's rest transform (Unreal space). */
	VIBELANDCITY_API FTransform RestTransform(const VlChunk& Chunk);

	/** One mesh section's buffers. */
	struct FSection
	{
		TArray<FVector> Vertices;
		TArray<int32> Triangles;
		TArray<FVector> Normals;
		TArray<FVector2D> UV0;
		TArray<FVector2D> UV1;
		/** (height above the ground in the intact city in metres, interior): interior is 1 on a face
		 * bonded neighbours covered. Fixed to the surface, so weathering keyed to it stays on a chunk
		 * that breaks away. */
		TArray<FVector2D> UV2;
		TArray<FProcMeshTangent> Tangents;

		void Reset()
		{
			Vertices.Reset();
			Triangles.Reset();
			Normals.Reset();
			UV0.Reset();
			UV1.Reset();
			UV2.Reset();
			Tangents.Reset();
		}
	};

	/** What the chunk material reads per catalog entry: (texture-array layer, metalness) in UV1,
	 * the factor on the core's tile UVs, and whether faces of it are glass. */
	struct VIBELANDCITY_API FCatalogMap
	{
		TArray<FVector2D> LayerMetal;
		TArray<float> UvScale;
		TArray<bool> Glass;

		/** `bHd`: drawn with the 2K sources (UVs scaled by metres_per_tile / hd_metres_per_tile). */
		static FCatalogMap Build(bool bHd);
	};

	/** Append chunk `ChunkIndex` of `Meshes`, its vertices through `ToComponent`, each triangle to
	 * the glass or the opaque section by its material; `Rest` is the chunk's rest transform
	 * (RestTransform), for UV2. */
	VIBELANDCITY_API void AppendChunk(const VlMeshView& Meshes, int32 ChunkIndex, const FTransform& ToComponent, const FTransform& Rest,
		const FCatalogMap& Catalog, FSection& Opaque, FSection& Glass);

#if WITH_EDITOR
	/** A static mesh holding one section (no welding: each triangle keeps its own corners, as the
	 * runtime mesh does), with a mesh distance field for Lumen, built (asynchronously where the
	 * engine compiles meshes in the background). Editor builds only: the import step bakes cells
	 * with it, and a game run from the editor binaries bakes broken cells. */
	VIBELANDCITY_API UStaticMesh* BuildStaticMesh(UObject* Outer, FName Name, const FSection& Section, bool bNanite, EObjectFlags Flags = RF_NoFlags);
#endif

	/** Where an imported city's cells are kept: /Game/VibeCity/Scenes/<first 16 of the hash>_<HD|Web>. */
	VIBELANDCITY_API FString SceneFolder(const FString& ManifestHash, bool bHd);
	/** A cell's static mesh asset name in that folder (Cell_<x>_<y>, and _Glass for its glass). */
	VIBELANDCITY_API FString CellAssetName(FIntPoint Key, bool bGlass);
}
