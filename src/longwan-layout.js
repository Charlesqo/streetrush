// Authored venue layout. One interval table owns visual kerbs and surface IDs.
// Side +1 is track.sample.side (right along the first eastbound straight).
// Small gaps around tight source-curve knots avoid self-intersecting offsets.
export const LONGWAN_KERBS = Object.freeze([
  {id:'t1-entry-inner',start:.304,end:.3415,side:1},
  {id:'t1-apex-inner',start:.3455,end:.366,side:1},
  {id:'t1-exit',start:.366,end:.395,side:-1},
  {id:'t2-entry-inner',start:.406,end:.4155,side:1},
  {id:'t2-apex-inner',start:.4205,end:.462,side:1},
  {id:'t2-exit',start:.462,end:.488,side:-1},
  {id:'t3-inner',start:.492,end:.514,side:1},
  {id:'t4-inner',start:.543,end:.566,side:1},
  {id:'esses-entry-inner',start:.579,end:.5885,side:-1},
  {id:'esses-exit-inner',start:.5945,end:.622,side:-1},
  {id:'esses-exit',start:.624,end:.650,side:1},
  {id:'south-inner',start:.677,end:.742,side:1},
  {id:'south-exit',start:.744,end:.774,side:-1},
  {id:'west-inner',start:.856,end:.901,side:1},
  {id:'final-entry-inner',start:.919,end:.944,side:1},
  {id:'final-apex-inner',start:.950,end:.963,side:1},
  {id:'final-exit',start:.968,end:.987,side:-1},
]);
export const KERB_WIDTH = 1.05;
export function kerbAt(sections,t,side){
  const progress=((t%1)+1)%1;
  return sections?.find(section=>section.side===side && progress>=section.start && progress<=section.end)??null;
}
export function pavedRunoffAt(t){return t>=0 && t<=.301;}
export function kerbHeight(station,widthFraction,length){
  const taper=Math.min(1,station/2,(length-station)/2);
  const phase=((station/.5)%1+1)%1;
  const tooth=Math.min(phase/.8,(1-phase)/.2);
  return .018+Math.max(0,taper)*widthFraction*(KERB_WIDTH*Math.tan(4*Math.PI/180)+.025*tooth);
}
