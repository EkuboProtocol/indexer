import * as cdk from "aws-cdk-lib";
import { Stack, StackProps, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as custom_resources from "aws-cdk-lib/custom-resources";

export class DbStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Create a new VPC for the RDS instance
    const vpc = new ec2.Vpc(this, "PostgresVpc", {
      maxAzs: 2,
    });

    // Create the RDS PostgreSQL instance
    const postgresInstance = new rds.DatabaseInstance(
      this,
      "PostgresInstance",
      {
        engine: rds.DatabaseInstanceEngine.postgres({
          version: rds.PostgresEngineVersion.VER_16_4,
        }),
        instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.BURSTABLE4_GRAVITON,
          ec2.InstanceSize.MEDIUM
        ),
        vpc,
        allocatedStorage: 100,
        storageType: rds.StorageType.IO2,
        backupRetention: Duration.days(7), // Automated backups enabled for 7 days
        deleteAutomatedBackups: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY, // Change to RETAIN for production
        deletionProtection: false,
        publiclyAccessible: true,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PUBLIC,
        },
        multiAz: false,
        autoMinorVersionUpgrade: true,
        databaseName: "postgres",
        credentials: rds.Credentials.fromGeneratedSecret("postgres"), // Auto-generated password
      }
    );

    // Lambda function to run database migrations
    const migrationFunction = new lambda.Function(this, "MigrationFunction", {
      runtime: lambda.Runtime.NODEJS_LATEST,
      handler: "index.handler",
      code: lambda.Code.fromAsset("lambda"), // Lambda code directory
      environment: {
        DB_HOST: postgresInstance.dbInstanceEndpointAddress,
        DB_PORT: postgresInstance.dbInstanceEndpointPort,
        DB_NAME: "mydatabase",
        DB_SECRET_ARN: postgresInstance.secret!.secretArn,
      },
      vpc,
      securityGroups: [postgresInstance.connections.securityGroups[0]],
    });

    // Grant Lambda function permission to read the database credentials
    postgresInstance.secret!.grantRead(migrationFunction);

    // Custom resource to trigger the migration Lambda during deployment
    const provider = new custom_resources.Provider(this, "MigrationProvider", {
      onEventHandler: migrationFunction,
    });

    new cdk.CustomResource(this, "MigrationResource", {
      serviceToken: provider.serviceToken,
    });

    // Ensure the migration runs after the database is ready
    migrationFunction.node.addDependency(postgresInstance);
  }
}
