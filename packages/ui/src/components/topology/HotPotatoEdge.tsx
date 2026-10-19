import {
  BaseEdge,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import type { HotPotatoEdgeData } from "../../lib/topology-activity.js";

export function HotPotatoEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const edgeData = (data ?? {}) as HotPotatoEdgeData;
  const packet = edgeData.hotPotatoPacket ?? null;
  const crossSoftwareTeam = edgeData.hotPotatoCrossSoftwareTeam ?? false;
  const reducedMotion = edgeData.hotPotatoReducedMotion ?? false;
  const strokeWidth = packet ? (crossSoftwareTeam ? 1.25 : 2.25) : style?.strokeWidth;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          strokeWidth,
          filter: packet ? "drop-shadow(0 0 3px rgba(16,185,129,0.22))" : style?.filter,
        }}
      />
      {packet ? (
        reducedMotion ? (
          <circle
            data-testid={`hot-potato-packet-${packet.id}`}
            data-reduced-motion="true"
            cx={targetX}
            cy={targetY}
            r={crossSoftwareTeam ? 5 : 6.5}
            stroke="rgba(255,255,255,0.88)"
            strokeWidth={crossSoftwareTeam ? 1.75 : 2.25}
            vectorEffect="non-scaling-stroke"
            className={crossSoftwareTeam ? "fill-outline" : "fill-emerald-600"}
          />
        ) : (
          <>
            {/* OPR.0.4.1.26 — directional flow: a dashed overlay that travels
                source -> destination along the edge, so the DIRECTION of the
                handoff reads at a glance even before the lead pulse arrives.
                CSS keyframe marches stroke-dashoffset (no framer-motion). */}
            <path
              data-testid={`hot-potato-flow-${packet.id}`}
              d={edgePath}
              fill="none"
              stroke={crossSoftwareTeam ? "#a8a29e" : "#10b981"}
              strokeWidth={crossSoftwareTeam ? 1.5 : 2.5}
              strokeLinecap="round"
              strokeDasharray={crossSoftwareTeam ? "1 12" : "2 11"}
              vectorEffect="non-scaling-stroke"
              className={crossSoftwareTeam ? "hot-potato-flow hot-potato-flow-cross" : "hot-potato-flow"}
            />
            {/* The lead pulse — the head of the handoff travelling the edge. */}
            <circle
              key={packet.id}
              data-testid={`hot-potato-packet-${packet.id}`}
              data-reduced-motion="false"
              r={crossSoftwareTeam ? 5 : 6.5}
              stroke="rgba(255,255,255,0.88)"
              strokeWidth={crossSoftwareTeam ? 1.75 : 2.25}
              vectorEffect="non-scaling-stroke"
              className={crossSoftwareTeam ? "fill-outline hot-potato-packet-cross" : "fill-emerald-600 hot-potato-packet"}
            >
              <animateMotion
                dur={`${packet.durationMs}ms`}
                path={edgePath}
                fill="freeze"
                calcMode="spline"
                keySplines="0.2 0 0 1"
                keyTimes="0;1"
              />
            </circle>
          </>
        )
      ) : null}
    </>
  );
}
