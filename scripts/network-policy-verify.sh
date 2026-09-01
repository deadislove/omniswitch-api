#!/bin/bash
# Bidirectional connectivity probe for k8s/network-policy.yaml, against a
# real NetworkPolicy-enforcing CNI (verified against kind + Calico — kind's
# own default CNI does not enforce NetworkPolicy at all, so this would
# silently pass against it for the wrong reason). Not a Jest e2e test: this
# asserts raw TCP reachability between pods, which the app-level e2e suite
# has no way to express.
#
# Assumes the target namespace already has pods bearing the labels
# k8s/network-policy.yaml references (app: omniswitch-api,
# pgbouncer-master/pgbouncer-replica, postgres-master/postgres-replica,
# redis, vault) — this script only creates its own ephemeral probe pods
# (including stand-in "ingress-nginx" and "monitoring" namespaces/pods,
# since real ingress-nginx/Prometheus installs are much larger separate
# pieces of infrastructure to validate these two rules against), it does
# not stand up stand-ins for the targets themselves.
#
# Checks both directions on purpose: only testing the refused side would
# pass identically whether the policy is correct or accidentally blocking
# everything, including the app's own intended traffic. A Kubernetes
# NetworkPolicy's Egress rule on a source pod does not implicitly grant
# the matching Ingress permission on the destination — both sides need
# their own rule, or the destination refuses the connection even though
# the source is allowed to send it. That failure mode looks identical to
# "the policy is working correctly" if only the refused side is checked.
set -euo pipefail

NAMESPACE="${NETPOL_VERIFY_NAMESPACE:-payments}"
INGRESS_NAMESPACE="${NETPOL_VERIFY_INGRESS_NAMESPACE:-ingress-nginx}"
MONITORING_NAMESPACE="${NETPOL_VERIFY_MONITORING_NAMESPACE:-monitoring}"
# Suffixed with this process's PID so back-to-back runs never collide with
# a same-named pod that's still mid-termination from the previous run —
# `kubectl delete --wait=false` below returns before deletion actually
# finishes, and a same-named `kubectl run` against a still-terminating pod
# fails with "AlreadyExists: object is being deleted".
RUN_ID="$$"
AUTHORIZED_POD="netpol-verify-authorized-${RUN_ID}"
UNAUTHORIZED_POD="netpol-verify-unauthorized-${RUN_ID}"
INGRESS_POD="netpol-verify-ingress-${RUN_ID}"
BATCHJOB_POD="netpol-verify-batchjob-${RUN_ID}"
PROMETHEUS_POD="netpol-verify-prometheus-${RUN_ID}"
FAILURES=0

cleanup() {
  kubectl delete pod "$AUTHORIZED_POD" "$UNAUTHORIZED_POD" "$BATCHJOB_POD" -n "$NAMESPACE" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl delete pod "$INGRESS_POD" -n "$INGRESS_NAMESPACE" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl delete pod "$PROMETHEUS_POD" -n "$MONITORING_NAMESPACE" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Creating probe pods in namespace '$NAMESPACE'"
kubectl run "$AUTHORIZED_POD" -n "$NAMESPACE" --image=busybox:1.36 --restart=Never \
  --labels="app=omniswitch-api" --command -- sleep 3600 >/dev/null
kubectl run "$UNAUTHORIZED_POD" -n "$NAMESPACE" --image=busybox:1.36 --restart=Never \
  --labels="app=netpol-verify-unauthorized" --command -- sleep 3600 >/dev/null
kubectl run "$BATCHJOB_POD" -n "$NAMESPACE" --image=busybox:1.36 --restart=Never \
  --labels="workload-type=batch-job" --command -- sleep 3600 >/dev/null
kubectl wait --for=condition=Ready "pod/$AUTHORIZED_POD" "pod/$UNAUTHORIZED_POD" "pod/$BATCHJOB_POD" -n "$NAMESPACE" --timeout=60s >/dev/null

echo "==> Creating ingress-side probe pod in namespace '$INGRESS_NAMESPACE' (created if it doesn't already exist)"
kubectl create namespace "$INGRESS_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl label namespace "$INGRESS_NAMESPACE" app.kubernetes.io/name=ingress-nginx --overwrite >/dev/null
kubectl run "$INGRESS_POD" -n "$INGRESS_NAMESPACE" --image=busybox:1.36 --restart=Never --command -- sleep 3600 >/dev/null
kubectl wait --for=condition=Ready "pod/$INGRESS_POD" -n "$INGRESS_NAMESPACE" --timeout=60s >/dev/null

echo "==> Creating monitoring-side probe pod in namespace '$MONITORING_NAMESPACE' (created if it doesn't already exist; kubernetes.io/metadata.name is auto-assigned by the API server, matching the namespace's own name)"
kubectl create namespace "$MONITORING_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl run "$PROMETHEUS_POD" -n "$MONITORING_NAMESPACE" --image=busybox:1.36 --restart=Never --command -- sleep 3600 >/dev/null
kubectl wait --for=condition=Ready "pod/$PROMETHEUS_POD" -n "$MONITORING_NAMESPACE" --timeout=60s >/dev/null
# A pod passing kubelet's Ready check doesn't mean Calico's dataplane has
# finished programming NetworkPolicy rules for its IP yet — observed live,
# repeatedly, specifically on the cross-namespace (namespaceSelector-based)
# ingress-nginx rule: a freshly created probe pod got a spurious "refused"
# on an "expect open" check, which then passed cleanly on retry with no
# other change. Calico needs an extra resolution step for a
# namespaceSelector rule (which pods are currently in that labeled
# namespace) that a same-namespace podSelector rule doesn't, which is
# consistent with only that one check ever flaking. Give it a moment
# before the very first probe, then retry generously rather than
# optimistically.
sleep 5

probe() {
  local from_ns="$1" from_pod="$2" target="$3" target_ns="$4" port="$5" expect="$6" label="$7"
  local host="${target}.${target_ns}.svc.cluster.local"
  local got="refused"
  local attempt
  for attempt in 1 2 3 4 5; do
    if kubectl exec -n "$from_ns" "$from_pod" -- nc -zv -w 3 "$host" "$port" >/dev/null 2>&1; then
      got="open"
      break
    fi
    # Only retry the "expect open but got refused" case — that's the
    # direction where Calico policy-propagation lag can cause a false
    # negative. A got=open when refused was expected is a real signal
    # (over-permissive), never worth retrying away.
    if [ "$expect" != "open" ] || [ "$attempt" -eq 5 ]; then
      break
    fi
    sleep 3
  done
  if [ "$got" = "$expect" ]; then
    echo "  PASS  $label ($from_ns/$from_pod -> $host:$port, expected $expect, got $got)"
  else
    echo "  FAIL  $label ($from_ns/$from_pod -> $host:$port, expected $expect, got $got)"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "==> Authorized paths (app: omniswitch-api) — expect open"
probe "$NAMESPACE" "$AUTHORIZED_POD" "pgbouncer-master" "$NAMESPACE" 5432 open "api -> pgbouncer-master"
probe "$NAMESPACE" "$AUTHORIZED_POD" "redis" "$NAMESPACE" 6379 open "api -> redis"
probe "$NAMESPACE" "$AUTHORIZED_POD" "vault" "$NAMESPACE" 8200 open "api -> vault"

echo "==> Architecture-correctness negative check — expect refused"
probe "$NAMESPACE" "$AUTHORIZED_POD" "postgres-master" "$NAMESPACE" 5432 refused "api -> postgres-master direct (must go through pgbouncer instead)"

echo "==> Unauthorized pod (same namespace) — expect refused everywhere"
probe "$NAMESPACE" "$UNAUTHORIZED_POD" "pgbouncer-master" "$NAMESPACE" 5432 refused "unauthorized -> pgbouncer-master"
probe "$NAMESPACE" "$UNAUTHORIZED_POD" "postgres-master" "$NAMESPACE" 5432 refused "unauthorized -> postgres-master"
probe "$NAMESPACE" "$UNAUTHORIZED_POD" "postgres-replica" "$NAMESPACE" 5432 refused "unauthorized -> postgres-replica"
probe "$NAMESPACE" "$UNAUTHORIZED_POD" "redis" "$NAMESPACE" 6379 refused "unauthorized -> redis"
probe "$NAMESPACE" "$UNAUTHORIZED_POD" "vault" "$NAMESPACE" 8200 refused "unauthorized -> vault"

echo "==> Ingress-controller rule (requires an 'omniswitch-api'-labeled target already deployed in '$NAMESPACE')"
# Port 80 here, not 3000: probe() always connects via the Service's DNS
# name, so this must be the Service's own exposed port (k8s/service.yaml:
# port 80 -> targetPort 3000), not the pod's container port. Every other
# probe() call in this script happens to use a Service where port ==
# targetPort (redis, pgbouncer, vault), so this distinction was invisible
# until tested against the real omniswitch-api Service specifically —
# confirmed by direct packet capture showing the SYN going to the
# ClusterIP on the wrong port (a self-inflicted test bug, not a
# NetworkPolicy/Calico/kube-proxy defect).
probe "$INGRESS_NAMESPACE" "$INGRESS_POD" "omniswitch-api" "$NAMESPACE" 80 open "ingress-nginx -> omniswitch-api"
probe "$NAMESPACE" "$UNAUTHORIZED_POD" "omniswitch-api" "$NAMESPACE" 80 refused "unauthorized (non-ingress) -> omniswitch-api"

echo "==> Batch-job rule — expect open"
probe "$NAMESPACE" "$BATCHJOB_POD" "pgbouncer-master" "$NAMESPACE" 5432 open "batch-job -> pgbouncer-master"

echo "==> Prometheus rule (requires an 'omniswitch-api'-labeled target already deployed in '$NAMESPACE') — expect open"
probe "$MONITORING_NAMESPACE" "$PROMETHEUS_POD" "omniswitch-api" "$NAMESPACE" 80 open "monitoring -> omniswitch-api"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "All checks passed."
  exit 0
else
  echo "$FAILURES check(s) failed."
  exit 1
fi
