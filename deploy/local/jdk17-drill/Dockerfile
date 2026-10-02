FROM eclipse-temurin:17-jdk-jammy
WORKDIR /drill
COPY Drill.java .
RUN javac --add-modules jdk.httpserver,jdk.jfr Drill.java
CMD ["java", "--add-modules", "jdk.httpserver,jdk.jfr", "Drill"]
