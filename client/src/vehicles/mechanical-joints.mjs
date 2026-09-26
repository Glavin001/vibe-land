/** Physical attachment topology for authored moving parts. A collision contact
 * is not necessarily a structural joint: brake pads touch a rotating rotor,
 * and closely packed arms may touch a hub, without being welded to it.
 *
 * This selects measured interfaces only; it does not create bonds across gaps,
 * reduce their area, or change materials. Vehicle2 remains responsible for
 * wheel rotation/braking. Bearing compliance and moving graph frames are not
 * implemented by this classification.
 */
export function mechanicalJoints(parts, contacts) {
  const byId = new Map(parts.map(part => [part.id, part]));
  const joints = [], excluded = [];
  for (const contact of contacts) {
    const a = byId.get(contact.a), b = byId.get(contact.b);
    if (!a || !b) throw Error('Mechanical contact references an unknown part');
    const A = a.motion, B = b.motion;
    let attachment = 'fixed-contact', reason = null;
    if (A?.role === 'wheel' || B?.role === 'wheel') {
      const wheel = A?.role === 'wheel' ? A : B;
      const other = wheel === A ? B : A;
      if (!wheel.corner || wheel.corner !== other?.corner) {
        reason = 'wheel-contact-without-mount';
      } else if (other.role === 'wheel') {
        attachment = 'wheel-internal';
      } else if (wheel.component === 'hub' && other.role === 'upright') {
        attachment = 'wheel-bearing';
      } else if (wheel.component === 'hub' && other.role === 'axle') {
        attachment = 'drive-spline';
      } else {
        reason = 'rotating-wheel-contact';
      }
    } else if (A?.component === 'caliper' || B?.component === 'caliper') {
      const caliper = A?.component === 'caliper' ? A : B;
      const other = caliper === A ? B : A;
      if (caliper.corner && caliper.corner === other?.corner && other.role === 'upright') {
        attachment = 'caliper-mount';
      } else {
        reason = 'caliper-contact-without-mount';
      }
    }
    if (reason) excluded.push({...contact, reason});
    else joints.push({...contact, attachment});
  }
  return {joints, excluded};
}
