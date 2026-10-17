#include "VibeCityCells.h"

namespace VibeCityCells
{
	namespace
	{
		FVector ToVector(const float (&V)[3]) { return FVector(V[0], V[1], V[2]); }
	}

	FIntPoint CellKey(const FVector& RestPos)
	{
		return FIntPoint(FMath::FloorToInt(RestPos.X / CellSizeCm), FMath::FloorToInt(RestPos.Y / CellSizeCm));
	}

	FTransform RestTransform(const VlChunk& Chunk)
	{
		const FQuat Q = FQuat(Chunk.rest_quat[0], Chunk.rest_quat[1], Chunk.rest_quat[2], Chunk.rest_quat[3]).GetNormalized();
		return FTransform(Q, ToVector(Chunk.rest_pos));
	}

	FCatalogMap FCatalogMap::Build(bool bHd)
	{
		const VlMaterial* Catalog = nullptr;
		size_t Count = 0;
		vl_catalog(&Catalog, &Count);
		FCatalogMap Map;
		Map.LayerMetal.SetNum(static_cast<int32>(Count));
		Map.UvScale.SetNum(static_cast<int32>(Count));
		Map.Glass.SetNum(static_cast<int32>(Count));
		for (size_t i = 0; i < Count; ++i)
		{
			Map.UvScale[i] = bHd && Catalog[i].hd_metres_per_tile > 0.0f ? Catalog[i].metres_per_tile / Catalog[i].hd_metres_per_tile : 1.0f;
			Map.LayerMetal[i] = FVector2D(FMath::Max(Catalog[i].layer, 0), Catalog[i].metalness);
			Map.Glass[i] = (Catalog[i].flags & VL_MATERIAL_GLASS) != 0;
		}
		return Map;
	}

	void AppendChunk(const VlMeshView& M, int32 ChunkIndex, const FTransform& ToComponent, const FTransform& Rest, const FCatalogMap& Catalog,
		FSection& Opaque, FSection& Glass)
	{
		if (ChunkIndex < 0 || static_cast<size_t>(ChunkIndex) >= M.range_count)
		{
			return;
		}
		const VlMeshRange& R = M.ranges[ChunkIndex];
		// One material per triangle (the core assigns it per face): route each triangle by its first
		// vertex's material.
		for (uint32 t = 0; t + 2 < R.index_count; t += 3)
		{
			const uint32 First = R.first_vertex + M.indices[R.first_index + t];
			const int32 Material = static_cast<int32>(M.materials[First]);
			const bool bGlass = Catalog.Glass.IsValidIndex(Material) && Catalog.Glass[Material];
			FSection& S = bGlass ? Glass : Opaque;
			const FVector2D LayerMetal = Catalog.LayerMetal.IsValidIndex(Material) ? Catalog.LayerMetal[Material] : FVector2D::ZeroVector;
			const double UvScale = Catalog.UvScale.IsValidIndex(Material) ? Catalog.UvScale[Material] : 1.0;
			for (uint32 k = 0; k < 3; ++k)
			{
				const uint32 V = R.first_vertex + M.indices[R.first_index + t + k];
				S.Triangles.Add(S.Vertices.Num());
				S.Vertices.Add(ToComponent.TransformPosition(ToVector(M.positions[V])));
				S.Normals.Add(ToComponent.TransformVectorNoScale(ToVector(M.normals[V])));
				const float(&Tg)[4] = M.tangents[V];
				// Unreal derives the binormal as normal x tangent, flipped when bFlipTangentY; the core's
				// w is +1 when normal x tangent already points along +v.
				S.Tangents.Add(FProcMeshTangent(ToComponent.TransformVectorNoScale(FVector(Tg[0], Tg[1], Tg[2])), Tg[3] < 0.0f));
				S.UV0.Add(FVector2D(M.tile_uvs[V][0], M.tile_uvs[V][1]) * UvScale);
				S.UV1.Add(LayerMetal);
				// Height in metres only: Nanite quantises UVs over each cluster's range, and wide ranges
				// (city coordinates) cost the layer index in UV1 its precision.
				const double Height = Rest.TransformPosition(ToVector(M.positions[V])).Z / 100.0;
				S.UV2.Add(FVector2D(Height, M.interior ? static_cast<double>(M.interior[V]) : 0.0));
			}
		}
	}

	FString SceneFolder(const FString& ManifestHash, bool bHd)
	{
		return FString::Printf(TEXT("/Game/VibeCity/Scenes/%s_%s"), *ManifestHash.Left(16), bHd ? TEXT("HD") : TEXT("Web"));
	}

	FString CellAssetName(FIntPoint Key, bool bGlass)
	{
		return FString::Printf(TEXT("Cell_%d_%d%s"), Key.X, Key.Y, bGlass ? TEXT("_Glass") : TEXT(""));
	}
}
