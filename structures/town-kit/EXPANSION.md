# Four-building town kit

The user subsequently authorized building the other three assets while the café remains under review. All three builders are now implemented; each keeps its own acceptance evidence. Keep every building independently exportable, reviewable and reusable inside this directory; `/city` integration remains a later task.

## Buildings

1. **Victorian corner café and apartments:** finish local-damage and collapse settling, then final exterior/interior polish and acceptance.
2. **Clapboard porch house:** two storeys, pitched roof, covered porch, connected living/kitchen/dining downstairs, bedrooms and bathroom upstairs, open garden gate and picket fence. Its domestic scale and porch should distinguish it from the café.
3. **Brick corner grocery and upstairs flat:** broad open shop entrance, accessible sales floor, counter, stockroom and rear delivery entrance; a separate stair connects the flat. Use a masonry storefront, parapet and different window proportions.
4. **Workshop with storage loft:** a tall, permanently open vehicle bay, adjoining office and utility area, visibly supported loft, and an accessible stair. A gabled industrial roof and wide bay distinguish its silhouette and internal route.

## Composability

The café now uses `src/parts/envelope.mjs` for opening-aware walls, sash windows, siding and floor openings; extraction preserved exact output across 16 configurations. Stairs and furniture already have shared builders. Extract further roof, trim and landing-guard components when the next building supplies a concrete reuse case. Keep structural attachment and loose furniture placement distinct. Reuse the existing prop builders and palette/material tables. A component should carry its geometry, physical bonds and local authoring metadata together; scene composition remaps identities and transforms routes/cameras separately from ScenePack.

Give each building its own builder, room/entrance/route metadata, saved cameras, damage scenarios and native acceptance reports. Shared components must not turn the buildings into resized copies: footprint, roof, façade rhythm, circulation and room uses should differ. Doors and gates start open; furniture remains clear of routes.

## Acceptance

Each finished building must pass deterministic geometry/contact checks, intact convergence plus 30-second idle observation, native capsule traversal, independent/rotated reuse, local damage, support-loss collapse and visual inspection of actual intact/damaged recordings. Do not borrow a passing café result for a new composition. Stage only accepted assets.
