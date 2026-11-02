/**
 * YAML scaffolds for the "create resource" view.
 *
 * The `+` button is context sensitive: it opens the create tab with the
 * template of whatever resource collection is currently on screen. Kinds that
 * a user cannot create (nodes, events) have no template at all, and the
 * button is disabled for them instead of offering an apply that must fail.
 */

export interface TemplateSource {
  kind: string;
  apiVersion: string;
  plural: string;
  namespaced: boolean;
  label: string;
}

export interface CreateTemplate extends TemplateSource {
  /** Fully rendered YAML, ready to drop into the editor. */
  yaml: string;
}

/** Objects that exist only because the cluster produced them. */
const NOT_CREATABLE = new Set(['Node', 'Event']);

export function isCreateable(kind: string): boolean {
  return !NOT_CREATABLE.has(kind);
}

/** `  namespace: foo\n`, or nothing when no namespace is selected. */
const ns = (namespace?: string) => (namespace ? `  namespace: ${namespace}\n` : '');

function metadata(name: string, namespace?: string, extra = ''): string {
  return `metadata:\n  name: ${name}\n${ns(namespace)}${extra}`;
}

function deployment(namespace?: string): string {
  return `apiVersion: apps/v1
kind: Deployment
${metadata(
  'example-deployment',
  namespace,
  `  labels:
    app: example
`,
)}spec:
  replicas: 1
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: app
          image: nginx:1.27-alpine
          ports:
            - containerPort: 80
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
`;
}

function pod(namespace?: string): string {
  return `apiVersion: v1
kind: Pod
${metadata(
  'example-pod',
  namespace,
  `  labels:
    app: example
`,
)}spec:
  containers:
    - name: app
      image: nginx:1.27-alpine
      ports:
        - containerPort: 80
      resources:
        requests:
          cpu: 50m
          memory: 64Mi
        limits:
          cpu: 200m
          memory: 128Mi
`;
}

function statefulset(namespace?: string): string {
  return `apiVersion: apps/v1
kind: StatefulSet
${metadata('example-statefulset', namespace)}spec:
  serviceName: example-statefulset
  replicas: 1
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: app
          image: nginx:1.27-alpine
          ports:
            - containerPort: 80
          volumeMounts:
            - name: data
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        resources:
          requests:
            storage: 1Gi
`;
}

function daemonset(namespace?: string): string {
  return `apiVersion: apps/v1
kind: DaemonSet
${metadata('example-daemonset', namespace)}spec:
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: agent
          image: busybox:1.36
          command: ["/bin/sh", "-c", "while true; do date; sleep 60; done"]
`;
}

function replicaset(namespace?: string): string {
  return `apiVersion: apps/v1
kind: ReplicaSet
${metadata('example-replicaset', namespace)}spec:
  replicas: 1
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: app
          image: nginx:1.27-alpine
`;
}

function job(namespace?: string): string {
  return `apiVersion: batch/v1
kind: Job
${metadata('example-job', namespace)}spec:
  completions: 1
  backoffLimit: 3
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: task
          image: busybox:1.36
          command: ["/bin/sh", "-c", "echo hello from kubepilot"]
`;
}

function cronjob(namespace?: string): string {
  return `apiVersion: batch/v1
kind: CronJob
${metadata('example-cronjob', namespace)}spec:
  schedule: "*/5 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: task
              image: busybox:1.36
              command: ["/bin/sh", "-c", "date; echo scheduled run"]
`;
}

function hpa(namespace?: string): string {
  return `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
${metadata('example-hpa', namespace)}spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: example-deployment
  minReplicas: 1
  maxReplicas: 5
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
`;
}

function pdb(namespace?: string): string {
  return `apiVersion: policy/v1
kind: PodDisruptionBudget
${metadata('example-pdb', namespace)}spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: example
`;
}

function configmap(namespace?: string): string {
  return `apiVersion: v1
kind: ConfigMap
${metadata('example-configmap', namespace)}data:
  LOG_LEVEL: info
  config.yaml: |
    server:
      port: 8080
`;
}

function secret(namespace?: string): string {
  return `apiVersion: v1
kind: Secret
${metadata('example-secret', namespace)}type: Opaque
stringData:
  username: admin
  password: change-me
`;
}

function resourcequota(namespace?: string): string {
  return `apiVersion: v1
kind: ResourceQuota
${metadata('example-quota', namespace)}spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    pods: "20"
`;
}

function limitrange(namespace?: string): string {
  return `apiVersion: v1
kind: LimitRange
${metadata('example-limits', namespace)}spec:
  limits:
    - type: Container
      default:
        cpu: 200m
        memory: 128Mi
      defaultRequest:
        cpu: 50m
        memory: 64Mi
`;
}

function lease(namespace?: string): string {
  return `apiVersion: coordination.k8s.io/v1
kind: Lease
${metadata('example-lease', namespace)}spec:
  holderIdentity: example
  leaseDurationSeconds: 15
`;
}

function priorityclass(namespace?: string): string {
  return `apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
${metadata('example-priority')}value: 1000
globalDefault: false
description: Example priority class created from KubePilot
`;
}

function runtimeclass(): string {
  return `apiVersion: node.k8s.io/v1
kind: RuntimeClass
${metadata('example-runtime')}handler: runc
`;
}

function mutatingwebhook(namespace?: string): string {
  const target = namespace ?? 'default';
  return `apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
${metadata('example-mutating-webhook')}webhooks:
  - name: example.example.com
    admissionReviewVersions: ["v1"]
    sideEffects: None
    clientConfig:
      service:
        name: webhook-server
        namespace: ${target}
        path: /mutate
        port: 443
    rules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE"]
        resources: ["pods"]
`;
}

function service(namespace?: string): string {
  return `apiVersion: v1
kind: Service
${metadata('example-service', namespace)}spec:
  type: ClusterIP
  selector:
    app: example
  ports:
    - name: http
      port: 80
      targetPort: 80
`;
}

function endpoints(namespace?: string): string {
  return `apiVersion: v1
kind: Endpoints
${metadata('example-endpoints', namespace)}subsets:
  - addresses:
      - ip: 10.0.0.10
    ports:
      - port: 8080
`;
}

function ingress(namespace?: string): string {
  return `apiVersion: networking.k8s.io/v1
kind: Ingress
${metadata('example-ingress', namespace)}spec:
  ingressClassName: nginx
  rules:
    - host: example.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: example-service
                port:
                  number: 80
`;
}

function ingressclass(): string {
  return `apiVersion: networking.k8s.io/v1
kind: IngressClass
${metadata('example-ingress-class')}spec:
  controller: example.com/ingress-controller
`;
}

function networkpolicy(namespace?: string): string {
  return `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
${metadata('example-network-policy', namespace)}spec:
  podSelector:
    matchLabels:
      app: example
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: allowed
      ports:
        - protocol: TCP
          port: 80
`;
}

function pvc(namespace?: string): string {
  return `apiVersion: v1
kind: PersistentVolumeClaim
${metadata('example-pvc', namespace)}spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
`;
}

function pv(): string {
  return `apiVersion: v1
kind: PersistentVolume
${metadata('example-pv')}spec:
  capacity:
    storage: 1Gi
  accessModes: [ReadWriteOnce]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: manual
  hostPath:
    path: /tmp/example-pv
    type: DirectoryOrCreate
`;
}

function storageclass(): string {
  return `apiVersion: storage.k8s.io/v1
kind: StorageClass
${metadata('example-storage-class')}provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
`;
}

function csidriver(): string {
  return `apiVersion: storage.k8s.io/v1
kind: CSIDriver
${metadata('example.csi.k8s.io')}spec:
  attachRequired: false
  podInfoOnMount: true
`;
}

function serviceaccount(namespace?: string): string {
  return `apiVersion: v1
kind: ServiceAccount
${metadata('example-service-account', namespace)}`;
}

function role(namespace?: string): string {
  return `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
${metadata('example-role', namespace)}rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
`;
}

function rolebinding(namespace?: string): string {
  return `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
${metadata('example-role-binding', namespace)}roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: example-role
subjects:
  - kind: ServiceAccount
    name: example-service-account
    namespace: ${namespace ?? 'default'}
`;
}

function clusterrole(): string {
  return `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
${metadata('example-cluster-role')}rules:
  - apiGroups: [""]
    resources: ["nodes", "pods"]
    verbs: ["get", "list", "watch"]
`;
}

function clusterrolebinding(): string {
  return `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
${metadata('example-cluster-role-binding')}roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: example-cluster-role
subjects:
  - kind: ServiceAccount
    name: example-service-account
    namespace: default
`;
}

function namespaceTemplate(): string {
  return `apiVersion: v1
kind: Namespace
${metadata('example-namespace', undefined, `  labels:
    name: example-namespace
`)}`;
}

function crd(): string {
  return `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
${metadata('examples.example.com')}spec:
  group: example.com
  scope: Namespaced
  names:
    plural: examples
    singular: example
    kind: Example
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                size:
                  type: integer
`;
}

/** Minimal but valid skeleton for anything we have no hand-written sample for. */
function generic(source: TemplateSource, namespace?: string): string {
  const nsLine = source.namespaced ? ns(namespace) : '';
  return `apiVersion: ${source.apiVersion}
kind: ${source.kind}
metadata:
  name: example
${nsLine}spec: {}
`;
}

const BUILDERS: Record<string, (namespace?: string) => string> = {
  Pod: pod,
  Deployment: deployment,
  StatefulSet: statefulset,
  DaemonSet: daemonset,
  ReplicaSet: replicaset,
  Job: job,
  CronJob: cronjob,
  HorizontalPodAutoscaler: hpa,
  PodDisruptionBudget: pdb,
  ConfigMap: configmap,
  Secret: secret,
  ResourceQuota: resourcequota,
  LimitRange: limitrange,
  Lease: lease,
  PriorityClass: priorityclass,
  RuntimeClass: runtimeclass,
  MutatingWebhookConfiguration: mutatingwebhook,
  Service: service,
  Endpoints: endpoints,
  Ingress: ingress,
  IngressClass: ingressclass,
  NetworkPolicy: networkpolicy,
  PersistentVolumeClaim: pvc,
  PersistentVolume: pv,
  StorageClass: storageclass,
  CSIDriver: csidriver,
  ServiceAccount: serviceaccount,
  Role: role,
  RoleBinding: rolebinding,
  ClusterRole: clusterrole,
  ClusterRoleBinding: clusterrolebinding,
  Namespace: namespaceTemplate,
  CustomResourceDefinition: crd,
};

const DEFAULT_SOURCE: TemplateSource = {
  kind: 'Deployment',
  apiVersion: 'apps/v1',
  plural: 'deployments',
  namespaced: true,
  label: 'Deployments',
};

/**
 * Builds the YAML scaffold for one kind. Returns `undefined` for objects the
 * user cannot create, so callers can disable the action instead of opening an
 * editor that is guaranteed to be rejected.
 */
export function templateFor(source: TemplateSource, namespace?: string): CreateTemplate | undefined {
  if (!isCreateable(source.kind)) return undefined;
  const build = BUILDERS[source.kind];
  return {
    kind: source.kind,
    apiVersion: source.apiVersion,
    plural: source.plural,
    namespaced: source.namespaced,
    label: source.label,
    yaml: build ? build(namespace) : generic(source, namespace),
  };
}

/** Used when the create action is triggered without a resource on screen. */
export function defaultTemplate(namespace?: string): CreateTemplate {
  return templateFor(DEFAULT_SOURCE, namespace)!;
}
